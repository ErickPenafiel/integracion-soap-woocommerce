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

async function asegurarCategoriaJerarquia(nombreCategoria) {
	const niveles = nombreCategoria
		.split("/")
		.map((n) => n.trim())
		.filter((n) => n);

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

async function asegurarMarca(nombreMarca) {
	try {
		const nombreFormateado = nombreMarca.trim().toUpperCase();

		// Buscar la marca por nombre
		const response = await wcApi.get("products/brands", {
			search: nombreFormateado,
			per_page: 100,
		});

		const marcaExistente = response.data.find(
			(brand) => brand.name.trim().toUpperCase() === nombreFormateado
		);

		if (marcaExistente) {
			return marcaExistente.id;
		}

		const nueva = await wcApi.post("products/brands", {
			name: nombreFormateado,
		});
		console.log(`🆕 Marca "${nombreFormateado}" creada.`);

		return nueva.data.id;
	} catch (error) {
		console.error(`❌ Error asegurando marca "${nombreMarca}":`, error.message);
		return null;
	}
}

async function procesarProductoIndividual(soapClient, item, cotizacion) {
	const imagenes = [];
	let pdfs;

	// Validar URL imagen
	if (item.URL_IMAGEN_PRIMARIA && item.URL_IMAGEN_PRIMARIA.includes(".")) {
		const ext = item.URL_IMAGEN_PRIMARIA.split(".").pop();
		let imagenBase64 = await intentarObtenerImagen(
			soapClient,
			item.URL_IMAGEN_PRIMARIA,
			ext
		);

		if (imagenBase64 && !imagenBase64.startsWith("C:")) {
			console.log(`🖼 Imagen válida obtenida para SKU ${item.ART_CODIGO}`);
			const imageUrl = await subirImagenDesdeBase64(imagenBase64);
			if (imageUrl) imagenes.push({ src: imageUrl });
		} else {
			console.log(`❌ Imagen no válida para SKU ${item.ART_CODIGO}`);
		}
	}

	const pdfBuffer = await obtenerPDFBufferDesdeSOAP(item.URL_DOCUMENTOS);
	if (pdfBuffer) {
		console.log(`📄 PDF obtenido (${pdfBuffer.length} bytes)`);
		const pdf = await subirPDFaWordPress(pdfBuffer);
		if (pdf) {
			pdfs = pdf;
		}
	}

	console.log("PDFS", pdfs);

	const categoriasNombres = [
		item.FAMILIA,
		item.FAMILIA_NIVEL1,
		item.FAMILIA_NIVEL2,
	].filter((c) => c && c !== "NULL");

	const categoriasIds = [];
	for (const nombre of categoriasNombres) {
		const id = await asegurarCategoriaJerarquia(nombre);
		if (id) categoriasIds.push({ id });
	}

	const marcasNombres = [item.MARCA].filter((m) => m && m !== "NULL");
	const marcasIds = [];
	for (const nombre of marcasNombres) {
		const id = await asegurarMarca(nombre);
		if (id) marcasIds.push(id);
	}

	const productoWoo = construirProductoWoo(
		item,
		imagenes,
		pdfs,
		categoriasIds,
		cotizacion,
		marcasIds
	);

	await retry(
		async () => {
			const responseGet = await wcApi.get("products", { sku: productoWoo.sku });
			const existentes = responseGet.data;

			if (existentes && existentes.length > 0) {
				const existenteOriginal = existentes[0];
				const existente = mapearProductoWooExistente(existenteOriginal);

				let response;

				if (!_.isEqual(productoWoo, existente)) {
					response = await wcApi.put(
						`products/${existenteOriginal.id}`,
						productoWoo
					);

					console.log(`🔄 SKU ${productoWoo.sku} actualizado.`);
				} else {
					console.log(
						`✅ SKU ${productoWoo.sku} sin cambios. No se actualiza.`
					);
				}
			} else {
				await wcApi.post("products", productoWoo);
				console.log(`🆕 SKU ${productoWoo.sku} creado.`);
			}
		},
		{
			retries: 3,
			minTimeout: 2000,
			onRetry: (err, attempt) => {
				console.warn(
					`Reintentando SKU ${productoWoo.sku} (Intento ${attempt})...`
				);
			},
		}
	);
}

function chunkArray(array, size) {
	const result = [];
	for (let i = 0; i < array.length; i += size) {
		result.push(array.slice(i, i + size));
	}
	return result;
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

		// 3. Obtener productos existentes de WooCommerce
		async function obtenerProductosExistentes() {
			let page = 1;
			const productosExistentes = [];

			while (true) {
				const response = await wcApi.get("products", { per_page: 100, page });
				if (response.data.length === 0) break;
				productosExistentes.push(...response.data);
				page++;
			}
			return new Map(productosExistentes.map((p) => [p.sku, p]));
		}

		const productosExistentesMap = await obtenerProductosExistentes();
		console.log(
			"🔍 Productos existentes en WooCommerce:",
			productosExistentesMap.size
		);

		// 4. Procesar productos SOAP y armar batches
		const productosParaCrear = [];
		const productosParaActualizar = [];

		const limit = pLimit(8);

		await Promise.all(
			productos.map((item) =>
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
						const pdf = pdfBuffer ? await subirPDFaWordPress(pdfBuffer) : null;

						const categoriasNombres = [
							item.FAMILIA,
							item.FAMILIA_NIVEL1,
							item.FAMILIA_NIVEL2,
						].filter((c) => c && c !== "NULL");
						const categoriasIds = [];
						for (const nombre of categoriasNombres) {
							const id = await asegurarCategoriaJerarquia(nombre);
							if (id) categoriasIds.push({ id });
						}

						const marcasNombres = [item.MARCA].filter((m) => m && m !== "NULL");
						const marcasIds = [];
						for (const nombre of marcasNombres) {
							const id = await asegurarMarca(nombre);
							if (id) marcasIds.push(id);
						}

						const productoWoo = construirProductoWoo(
							item,
							imagenes,
							pdf,
							categoriasIds,
							cotizacion,
							marcasIds
						);
						const existente = productosExistentesMap.get(productoWoo.sku);

						if (existente) {
							const productoExistenteMapeado =
								mapearProductoWooExistente(existente);
							if (!_.isEqual(productoWoo, productoExistenteMapeado)) {
								productoWoo.id = existente.id;
								productosParaActualizar.push(productoWoo);
							}
						} else {
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

		// 5. Enviar lotes a WooCommerce
		const chunkArray = (array, size) => {
			const result = [];
			for (let i = 0; i < array.length; i += size) {
				result.push(array.slice(i, i + size));
			}
			return result;
		};

		const enviarBatch = async (crear, actualizar) => {
			const response = await wcApi.post("products/batch", {
				create: crear,
				update: actualizar,
			});
			console.log(
				`🆕 Creados: ${response.data.create.length}, 🔄 Actualizados: ${response.data.update.length}`
			);
		};

		for (const chunk of chunkArray(productosParaCrear, 50)) {
			await enviarBatch(chunk, []);
		}
		for (const chunk of chunkArray(productosParaActualizar, 50)) {
			await enviarBatch([], chunk);
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
