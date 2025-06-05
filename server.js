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
const logger = require("./src/services/logger");
const {
	obtenerTodasLasCategorias,
	procesarImagenesCategorias,
} = require("./src/services/categorias-service");
const {
	obtenerTodasLasMarcas,
	procesarMarcasWooDesdeSOAP,
} = require("./src/services/marcas-service");

const app = express();
const port = 5000;

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

const soapUrl = process.env.SOAP_URL;
const options = { timeout: 15000 };

const cacheBuffersPDF = new Map();

const categoriaJerarquiaCache = new Map();

async function asegurarCategoriaJerarquia(
	nombreCategoria,
	nombreCategoria1,
	nombreCategoria2
) {
	const niveles = [nombreCategoria, nombreCategoria1, nombreCategoria2]
		.map((n) => n?.toString().trim().replace(/\s+/g, " ").toUpperCase())
		.filter((n) => n && n !== "NULL");

	logger.info(`✅ Comprobando jerarquía: ${niveles.join(" > ")}`);

	let parentId = 0;
	let rutaActual = [];

	for (let i = 0; i < niveles.length; i++) {
		const nivel = niveles[i];
		rutaActual.push(nivel);

		const claveSimple = nivel;
		const claveRuta = rutaActual.join(" > ");

		if (categoriaJerarquiaCache.has(claveRuta)) {
			const id = await categoriaJerarquiaCache.get(claveRuta);
			parentId = id;
			continue;
		}

		const promesaCategoria = (async () => {
			try {
				const response = await wcApi.get("products/categories", {
					search: nivel,
					parent: parentId,
					per_page: 100,
				});

				const categoriaExistente = response.data.find(
					(cat) => cat.name.toLowerCase() === nivel.toLowerCase()
				);

				if (categoriaExistente) {
					logger.info(
						`📁 Categoría existente encontrada: ${claveRuta} (ID: ${categoriaExistente.id})`
					);
					return categoriaExistente.id;
				}

				const nueva = await wcApi.post("products/categories", {
					name: nivel,
					parent: parentId !== 0 ? parentId : undefined,
				});
				logger.info(`🆕 Categoría creada: ${claveRuta} (ID: ${nueva.data.id})`);
				return nueva.data.id;
			} catch (error) {
				const errorData = error.response?.data || {};
				logger.error(`❌ Error en categoría "${nivel}": ${error.message}`);
				logger.error(`📄 Detalle: ${JSON.stringify(errorData, null, 2)}`);

				if (errorData.code === "term_exists" && errorData.data?.resource_id) {
					logger.warn(
						`⚠️ Categoría "${nivel}" ya existe. ID: ${errorData.data.resource_id}`
					);
					return errorData.data.resource_id;
				}

				throw error;
			}
		})();

		categoriaJerarquiaCache.set(claveRuta, promesaCategoria);

		const categoriaId = await promesaCategoria;
		parentId = categoriaId;

		if (i === 0 && !categoriaJerarquiaCache.has(claveSimple)) {
			categoriaJerarquiaCache.set(claveSimple, Promise.resolve(categoriaId));
		}
	}

	return parentId;
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
	soap.createClient(soapUrl, options, async function (err, soapClient) {
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
		const skuInicio = "46450200180";
		const indiceInicio = productos.findIndex((p) => p.ART_CODIGO === skuInicio);

		if (indiceInicio !== -1) {
			productos = productos.slice(indiceInicio);
			logger.info(
				`🔁 Empezando integración desde SKU ${skuInicio} (índice ${indiceInicio})`
			);
		} else {
			logger.warn(
				`⚠️ SKU ${skuInicio} no encontrado. Procesando todos los productos.`
			);
		}
		logger.info(`📦 Productos obtenidos desde SOAP: ${productos.length}`);

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
			return console.error(`Cotización no válida: ${cotizacion}`);
		}

		logger.info(`💵 Cotización obtenida desde SOAP: ${cotizacion}`);
		// console.log("Producto: ", productos[0]);

		await new Promise((resolve) => setTimeout(resolve, 3000));

		// Marcas Unicas
		const nombresMarcasUnicas = new Set(
			productos
				.map((item) => item.MARCA)
				.filter((nombre) => nombre && nombre !== "NULL")
				.map((nombre) => nombre.trim().toUpperCase())
		);

		logger.info(`Marcas únicas: ${nombresMarcasUnicas.size}`);
		const mapaMarcas = await crearMarcasBatch(nombresMarcasUnicas);
		logger.info(`🆕 Marcas creadas en WooCommerce ${mapaMarcas.size}`);

		// Obtener todas las marcas existentes
		const marcasExistentes = await wcApi.get("products/brands", {
			per_page: 100,
		});

		logger.info(`Marcas existentes: ${marcasExistentes.data.length}`);

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

				const info = {
					...(crear.length > 0 && { creados: response.data.create.length }),
					...(actualizar.length > 0 && {
						actualizados: response.data.update.length,
					}),
				};

				logger.info(`Resultado de sync: ${JSON.stringify(info)}`);
			} catch (error) {
				console.error("❌ Error al enviar batch:", error.message || error);
			}
		};

		const categorias = await obtenerTodasLasCategorias();
		await procesarImagenesCategorias(soapClient, categorias);

		const marcasWp = await obtenerTodasLasMarcas();
		await procesarMarcasWooDesdeSOAP(soapClient, marcasWp);

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

							if (
								item.URL_IMAGEN_SECUNDARIA &&
								item.URL_IMAGEN_SECUNDARIA.includes(".")
							) {
								const ext = item.URL_IMAGEN_SECUNDARIA.split(".").pop();
								const imagenBase64 = await intentarObtenerImagen(
									soapClient,
									item.URL_IMAGEN_SECUNDARIA,
									ext
								);

								if (imagenBase64 && !imagenBase64.startsWith("C:")) {
									const imageUrl = await subirImagenDesdeBase64(imagenBase64);
									if (imageUrl) imagenes.push({ src: imageUrl });
								}
							}

							if (item.URL_IMAGEN_3 && item.URL_IMAGEN_3.includes(".")) {
								const ext = item.URL_IMAGEN_3.split(".").pop();
								const imagenBase64 = await intentarObtenerImagen(
									soapClient,
									item.URL_IMAGEN_3,
									ext
								);

								if (imagenBase64 && !imagenBase64.startsWith("C:")) {
									const imageUrl = await subirImagenDesdeBase64(imagenBase64);
									if (imageUrl) imagenes.push({ src: imageUrl });
								}
							}

							if (item.URL_IMAGEN_4 && item.URL_IMAGEN_4.includes(".")) {
								const ext = item.URL_IMAGEN_4.split(".").pop();
								const imagenBase64 = await intentarObtenerImagen(
									soapClient,
									item.URL_IMAGEN_4,
									ext
								);

								if (imagenBase64 && !imagenBase64.startsWith("C:")) {
									const imageUrl = await subirImagenDesdeBase64(imagenBase64);
									if (imageUrl) imagenes.push({ src: imageUrl });
								}
							}

							if (item.URL_IMAGEN_5 && item.URL_IMAGEN_5.includes(".")) {
								const ext = item.URL_IMAGEN_5.split(".").pop();
								const imagenBase64 = await intentarObtenerImagen(
									soapClient,
									item.URL_IMAGEN_5,
									ext
								);

								if (imagenBase64 && !imagenBase64.startsWith("C:")) {
									const imageUrl = await subirImagenDesdeBase64(imagenBase64);
									if (imageUrl) imagenes.push({ src: imageUrl });
								}
							}

							if (item.URL_IMAGEN_6 && item.URL_IMAGEN_6.includes(".")) {
								const ext = item.URL_IMAGEN_6.split(".").pop();
								const imagenBase64 = await intentarObtenerImagen(
									soapClient,
									item.URL_IMAGEN_6,
									ext
								);

								if (imagenBase64 && !imagenBase64.startsWith("C:")) {
									const imageUrl = await subirImagenDesdeBase64(imagenBase64);
									if (imageUrl) imagenes.push({ src: imageUrl });
								}
							}

							if (item.URL_IMAGEN_7 && item.URL_IMAGEN_7.includes(".")) {
								const ext = item.URL_IMAGEN_7.split(".").pop();
								const imagenBase64 = await intentarObtenerImagen(
									soapClient,
									item.URL_IMAGEN_7,
									ext
								);

								if (imagenBase64 && !imagenBase64.startsWith("C:")) {
									const imageUrl = await subirImagenDesdeBase64(imagenBase64);
									if (imageUrl) imagenes.push({ src: imageUrl });
								}
							}

							async function obtenerPDFConCache(url) {
								if (!url) return null;
								if (cacheBuffersPDF.has(url)) return cacheBuffersPDF.get(url);

								const buffer = await obtenerPDFBufferDesdeSOAP(url);
								if (buffer) cacheBuffersPDF.set(url, buffer);

								return buffer;
							}

							const pdfBuffer = await obtenerPDFConCache(item.URL_DOCUMENTOS);

							const pdf = pdfBuffer
								? await subirPDFaWordPress(pdfBuffer, item.ART_CODIGO)
								: null;

							const fichaTecnicaBuffer = await obtenerPDFConCache(
								item.URL_FICHA_TECNICA
							);

							const fichaTecnica = fichaTecnicaBuffer
								? await subirPDFaWordPress(fichaTecnicaBuffer, item.ART_CODIGO)
								: null;

							const dimensionalBuffer = await obtenerPDFConCache(
								item.URL_DIMENSIONAL
							);

							const dimensional = dimensionalBuffer
								? await subirPDFaWordPress(dimensionalBuffer, item.ART_CODIGO)
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

							let promesaCategoria = cacheCategorias.get(categoriasName);

							if (!promesaCategoria) {
								promesaCategoria = asegurarCategoriaJerarquia(
									item.FAMILIA?.trim(),
									item.FAMILIA_NIVEL1?.trim(),
									item.FAMILIA_NIVEL2?.trim()
								).then((id) => {
									if (!id) {
										logger.warn(
											`❌ No se pudo asegurar la categoría: ${categoriasName}, usando fallback 7126`
										);
										return 7126;
									}
									logger.info(
										`🆕 Creando categoría: ${categoriasName} (ID: ${id})`
									);
									return id;
								});

								cacheCategorias.set(categoriasName, promesaCategoria);
							} else {
								logger.info(
									`⏳ Esperando creación ya iniciada para categoría: ${categoriasName}`
								);
							}

							const categoriaIdFinal = await promesaCategoria;
							categoriasIds = [{ id: categoriaIdFinal }];

							logger.info(
								`Categoría ID de ${item.ART_CODIGO}: ${JSON.stringify(
									categoriasIds
								)}`
							);

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
								marcasIds,
								fichaTecnica,
								dimensional
							);

							if (existente) {
								let productoExistenteMapeado =
									mapearProductoWooExistente(existente);

								if (!_.isEqual(productoWoo, productoExistenteMapeado)) {
									productoWoo.id = existente.id;

									logger.info(
										`🆕 Producto ${item.ART_CODIGO} SKU: ${productoWoo.sku} actualizar`
									);

									productosParaActualizar.push(productoWoo);
								}
							} else {
								logger.info(
									`🆕 Producto ${item.ART_CODIGO} SKU: ${productoWoo.sku}, crear`
								);
								productosParaCrear.push(productoWoo);
							}
						} catch (error) {
							logger.error(
								`❌ Error procesando SKU ${item.ART_CODIGO}: ${
									error.message || error
								}`
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

		logger.info("✅ Proceso de sincronización finalizado.");
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
