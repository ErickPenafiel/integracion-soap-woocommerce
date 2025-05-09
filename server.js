require("dotenv").config();

const express = require("express");
const soap = require("soap");
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const WPAPI = require("wpapi");
const retry = require("async-retry");
const pLimit = require("p-limit");
const _ = require("lodash");

const {
	obtenerImagenDesdeSOAP,
	obtenerPDFBufferDesdeSOAP,
} = require("./src/services/soap-service");
const {
	subirImagenDesdeBase64,
	subirPDFaWordPress,
} = require("./src/services/wp-service");
const { getSoapClient } = require("./src/services/soap-client");
const {
	mapearProductoWooExistente,
} = require("./mappers/mappProductoExistente");
const { construirProductoWoo } = require("./helpers/products");
const { intentarObtenerImagen } = require("./helpers/images");
const { type } = require("os");

const app = express();
const port = 5000;

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

const soapUrl = process.env.SOAP_URL;

async function asegurarCategoriaJerarquia(
	nombreCategoria,
	nombreCategoria1,
	nombreCategoria2
) {
	const niveles = [nombreCategoria, nombreCategoria1, nombreCategoria2]
		.map((n) => n?.toString().trim()) // asegurarse que sea string y quitar espacios
		.filter((n) => n && n.toUpperCase() !== "NULL"); // descarta null, "", "NULL"

	let parentId = 0;
	let ultimaCategoriaId = null;

	for (const nivel of niveles) {
		try {
			// Buscar categoría en este nivel
			const response = await wcApi.get("products/categories", {
				search: nivel,
				parent: parentId,
				per_page: 100,
			});

			let categoriaExistente = response.data.find(
				(cat) => cat.name.toLowerCase() === nivel.toLowerCase()
			);

			if (categoriaExistente) {
				ultimaCategoriaId = categoriaExistente.id;
			} else {
				// Crear categoría nueva en este nivel
				const nueva = await wcApi.post("products/categories", {
					name: nivel,
					parent: parentId !== 0 ? parentId : undefined,
				});
				console.log(`🆕 Categoría ${nivel} creada.`);
				ultimaCategoriaId = nueva.data.id;
			}

			// El siguiente nivel debe tener este como padre
			parentId = ultimaCategoriaId;
		} catch (error) {
			console.error(`❌ Error asegurando categoría "${nivel}":`, error.message);
			return null;
		}
	}

	return ultimaCategoriaId;
}

function chunkArray(array, size) {
	const result = [];
	for (let i = 0; i < array.length; i += size) {
		result.push(array.slice(i, i + size));
	}
	return result;
}

async function crearMarcasBatch(nombresMarcas) {
	const creadas = [];

	const chunks = chunkArray([...nombresMarcas], 10);
	for (const chunk of chunks) {
		const response = await wcApi.post("products/brands/batch", {
			create: chunk.map((name) => ({ name: name.trim() })),
		});
		creadas.push(...response.data.create);
	}
	return new Map(
		creadas
			.filter((m) => m && m.name) // ⚠️ filtra las que no tienen name
			.map((m) => [m.name.trim().toUpperCase(), m.id])
	);
}

async function procesarProductos() {
	soap.createClient(soapUrl, async function (err, soapClient) {
		if (err) {
			return console.error("Error al crear el cliente SOAP:", err);
		}

		const args = {};

		// 1. Obtener productos desde SOAP
		const result = await new Promise((resolve, reject) => {
			soapClient.servicebus.servicebusSoap12.getWebProductos(
				args,
				(err, result) => {
					if (err) return reject(err);
					resolve(result);
				}
			);
		});

		const diffgram = result.getWebProductosResult.diffgram;
		if (!diffgram || !diffgram.NewDataSet || !diffgram.NewDataSet.Table) {
			return console.error("No se encontraron productos en la respuesta SOAP.");
		}

		let productos = diffgram.NewDataSet.Table;
		if (!Array.isArray(productos)) {
			productos = [productos];
		}
		console.log("📦 Productos obtenidos desde SOAP:", productos.length);

		// 2. Obtener cotización
		const cotizacionResult = await new Promise((resolve, reject) => {
			soapClient.servicebus.servicebusSoap12.getWebCotizacion(
				args,
				(err, result) => {
					if (err) return reject(err);
					resolve(result);
				}
			);
		});

		const cotizacionDiffgram = cotizacionResult.getWebCotizacionResult.diffgram;
		let cotizacion = parseFloat(
			cotizacionDiffgram.NewDataSet.Table.COTIZACION.replace(",", ".")
		);
		if (isNaN(cotizacion)) {
			return console.error("Cotización no válida:", cotizacion);
		}

		console.log("💵 Cotización obtenida desde SOAP:", cotizacion);
		// console.log("Producto: ", productos[0]);

		await new Promise((resolve) => setTimeout(resolve, 3000));

		// Marcas Unicas
		const nombresMarcasUnicas = new Set(
			productos
				.map((item) => item.MARCA)
				.filter((nombre) => nombre && nombre !== "NULL")
				.map((nombre) => nombre.trim().toUpperCase())
		);

		console.log("Marcas únicas:", nombresMarcasUnicas.size);
		const mapaMarcas = await crearMarcasBatch(nombresMarcasUnicas);
		console.log("🆕 Marcas creadas en WooCommerce:", mapaMarcas.size);

		// Obtener todas las marcas existentes
		const marcasExistentes = await wcApi.get("products/brands", {
			per_page: 100,
		});

		console.log("Marcas existentes:", marcasExistentes.data.length);

		const marcas = marcasExistentes.data.map((marca) => {
			return {
				id: marca.id,
				name: marca.name.trim().toUpperCase(),
			};
		});
		const marcasMap = new Map(marcas.map((m) => [m.name, m.id]));
		// console.log("Marcas mapeadas:", marcasMap);

		// -----------------------------------------------------------------

		const chunkArray = (array, size) => {
			const result = [];
			for (let i = 0; i < array.length; i += size) {
				result.push(array.slice(i, i + size));
			}
			return result;
		};

		const enviarBatch = async (crear, actualizar) => {
			try {
				const response = await wcApi.post("products/batch", {
					create: crear,
					update: actualizar,
				});

				console.log({
					...(crear.length > 0 && { creados: response.data.create.length }),
					...(actualizar.length > 0 && {
						actualizados: response.data.update.length,
					}),
				});
			} catch (error) {
				console.error("❌ Error al enviar batch:", error.message || error);
			}
		};

		const cacheCategorias = new Map();

		const limit = pLimit(5);

		const chunks = chunkArray(productos, 50);

		for (const chunk of chunks) {
			const productosParaCrear = [];
			const productosParaActualizar = [];

			await Promise.all(
				chunk.map((item) =>
					limit(async () => {
						try {
							const imagenes = [];

							if (
								item.URL_IMAGEN_PRIMARIA &&
								item.URL_IMAGEN_PRIMARIA.includes(".")
							) {
								const ext = item.URL_IMAGEN_PRIMARIA.split(".").pop();
								const imagenBase64 = await intentarObtenerImagen(
									soapClient,
									item.URL_IMAGEN_PRIMARIA,
									ext
								);
								if (imagenBase64 && !imagenBase64.startsWith("C:")) {
									const imageUrl = await subirImagenDesdeBase64(imagenBase64);
									if (imageUrl) imagenes.push({ src: imageUrl });
								}
							}

							const pdfBuffer = await obtenerPDFBufferDesdeSOAP(
								item.URL_DOCUMENTOS
							);
							const pdf = pdfBuffer
								? await subirPDFaWordPress(pdfBuffer)
								: null;

							const marcasIds = item.MARCA
								? [marcasMap.get(item.MARCA.trim().toUpperCase())]
								: [];

							const categoriasName = [
								item.FAMILIA.trim(),
								item.FAMILIA_NIVEL1.trim(),
								item.FAMILIA_NIVEL2.trim(),
							].join(" > ");

							let categoriasIds = [];

							if (!cacheCategorias.has(categoriasName)) {
								const promesaCategoria = asegurarCategoriaJerarquia(
									item.FAMILIA?.trim(),
									item.FAMILIA_NIVEL1?.trim(),
									item.FAMILIA_NIVEL2?.trim()
								);

								cacheCategorias.set(categoriasName, promesaCategoria);
								await new Promise((resolve) => setTimeout(resolve, 1500));
							}

							const categoriaIdFinal = await cacheCategorias.get(
								categoriasName
							);
							categoriasIds = [
								{
									id: categoriaIdFinal,
								},
							];
							console.log("Categoría ID:", categoriasIds);

							let existente = await wcApi.get("products", {
								sku: item.ART_CODIGO,
							});
							if (existente && existente.data.length > 0) {
								existente = existente.data[0];
							}

							let productoWoo = construirProductoWoo(
								item,
								imagenes,
								pdf,
								categoriasIds,
								cotizacion,
								marcasIds
							);

							if (existente) {
								let productoExistenteMapeado =
									mapearProductoWooExistente(existente);

								if (!_.isEqual(productoWoo, productoExistenteMapeado)) {
									productoWoo.id = existente.id;

									console.log(
										`🆕 Producto ${item.ART_CODIGO} SKU: ${productoWoo.sku} actualizar`
									);

									productosParaActualizar.push(productoWoo);
								}
							} else {
								console.log(
									`🆕 Producto ${item.ART_CODIGO} SKU: ${productoWoo.sku}, crear`
								);
								productosParaCrear.push(productoWoo);
							}
						} catch (error) {
							console.error(
								`❌ Error procesando SKU ${item.ART_CODIGO}:`,
								error.message
							);
						}
					})
				)
			);

			if (productosParaCrear.length > 0 || productosParaActualizar.length > 0) {
				await enviarBatch(productosParaCrear, productosParaActualizar);

				await new Promise((resolve) => setTimeout(resolve, 3000));
			}
		}

		console.log("✅ Proceso de sincronización finalizado.");
	});
}

// cron.schedule("*/30 * * * *", () => {
// 	console.log("Ejecutando cron job: procesando productos.");
// 	procesarProductos();
// });

app.get("/integrar", (req, res) => {
	procesarProductos();
	res.send("Proceso de integración iniciado.");
});

app.listen(port, () => {
	console.log(`Servidor Express escuchando en http://localhost:${port}`);
});
