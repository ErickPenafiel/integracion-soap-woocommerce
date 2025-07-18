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
const dns = require("dns");

const url = new URL("https://recordelectric.com/");
const hostname = url.hostname;

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
const { actualizarPreciosDesdeMetaData } = require("./helpers/update-prices");

const app = express();
const port = 5000;

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
	axiosConfig: {
		timeout: 300000,
	},
});

const soapUrl = process.env.SOAP_URL;
const options = { timeout: 30000 };

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

		const promesaCategoria = retry(
			async (bail) => {
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

					logger.info(
						`🆕 Categoría creada: ${claveRuta} (ID: ${nueva.data.id})`
					);
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

					// Si es un error que no vale la pena reintentar, se cancela con bail
					if (
						error.response?.status >= 400 &&
						error.response?.status < 500 &&
						errorData.code !== "term_exists"
					) {
						console.log(
							"Bailing out due to non-retryable error:",
							error.message
						);
						return bail(error);
					}

					throw error;
				}
			},
			{
				retries: 3,
				minTimeout: 500,
				maxTimeout: 2000,
				factor: 2,
			}
		);

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
			.filter((m) => m && m.name)
			.map((m) => [m.name.trim().toUpperCase(), m.id])
	);
}

async function procesarProductos() {
	dns.lookup(hostname, (err, address, family) => {
		if (err) throw err;
		console.log(`IP de ${hostname}: ${address}`);
	});

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

		console.log("Resultado de getWebProductos:", result);
		let productos = [];

		const diffgram = result.getWebProductosResult.diffgram;
		if (!diffgram || !diffgram.NewDataSet || !diffgram.NewDataSet.Table) {
			console.error("No se encontraron productos en la respuesta SOAP.");
			productos = [];
		} else {
			productos = diffgram.NewDataSet.Table;

			if (!Array.isArray(productos)) {
				productos = [productos];
			}
		}

		// const skuInicio = "2317631736";
		// const indiceInicio = productos.findIndex((p) => p.ART_CODIGO === skuInicio);

		// if (indiceInicio !== -1) {
		// 	productos = productos.slice(indiceInicio, productos.length);
		// 	logger.info(
		// 		`🔁 Empezando integración desde SKU ${skuInicio} (índice ${indiceInicio})`
		// 	);
		// } else {
		// 	logger.warn(
		// 		`⚠️ SKU ${skuInicio} no encontrado. Procesando todos los productos.`
		// 	);
		// }
		// let productos = require("./productos_filtrados.json");
		// productos = productos.slice(40, 60);

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

		const nombresMarcasUnicas = new Set(
			productos
				.map((item) => item.MARCA)
				.filter((nombre) => nombre && nombre !== "NULL")
				.map((nombre) => nombre.trim().toUpperCase())
		);

		logger.info(`Marcas únicas: ${nombresMarcasUnicas.size}`);
		const mapaMarcas = await crearMarcasBatch(nombresMarcasUnicas);
		logger.info(`🆕 Marcas creadas en WooCommerce ${mapaMarcas.size}`);

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

		const chunkArray = (array, size) => {
			const result = [];
			for (let i = 0; i < array.length; i += size) {
				result.push(array.slice(i, i + size));
			}
			return result;
		};

		const retry = require("async-retry");

		const enviarBatch = async (crear, actualizar, batchSize = 10) => {
			const crearChunks = chunkArray(crear, batchSize);
			const actualizarChunks = chunkArray(actualizar, batchSize);

			const totalChunks = Math.max(crearChunks.length, actualizarChunks.length);

			for (let i = 0; i < totalChunks; i++) {
				const miniCrear = crearChunks[i] || [];
				const miniActualizar = actualizarChunks[i] || [];

				try {
					await retry(
						async (bail, attempt) => {
							try {
								const response = await wcApi.post("products/batch", {
									create: miniCrear,
									update: miniActualizar,
								});

								logger.info(
									"RESPUESTA BATCH" + JSON.stringify(response.data, null, 2)
								);

								if (response.data.errors && response.data.errors.length > 0) {
									logger.error("❌ Errores detectados en batch CREATE:");
									logger.error(JSON.stringify(response.data.errors, null, 2));
								}

								if (response.data.create && response.data.create.length !== 0) {
									const responseCreate = response.data.create.map((item) => ({
										id: item.id,
										permalink: item.permalink,
										name: item.name,
									}));
									logger.info(
										"Create" + JSON.stringify(responseCreate, null, 2)
									);
								}

								if (response.data.update && response.data.update.length !== 0) {
									const responseUpdate = response.data.update.map((item) => ({
										id: item.id,
										permalink: item.permalink,
										name: item.name,
									}));

									logger.info(
										"Update" + JSON.stringify(responseUpdate, null, 2)
									);
								}

								const info = {
									...(miniCrear.length > 0 && {
										creados: response.data.create.length,
									}),
									...(miniActualizar.length > 0 && {
										actualizados: response.data.update.length,
									}),
								};

								logger.info(
									`✅ Batch ${
										i + 1
									}/${totalChunks} completado (intento ${attempt}): ${JSON.stringify(
										info
									)}`
								);

								if (attempt > 1) {
									logger.info(
										`🔁 Batch ${
											i + 1
										} completado correctamente después de reintento #${attempt}`
									);
								}
							} catch (error) {
								if (
									error.response?.status >= 400 &&
									error.response?.status < 500
								) {
									bail(
										new Error(
											`Error no recuperable en batch ${i + 1}: ${
												error.response?.data?.message || error.message
											}`
										)
									);
									return;
								}
								throw error;
							}
						},
						{
							retries: 3,
							minTimeout: 1000,
							maxTimeout: 300000,
						}
					);
				} catch (error) {
					console.error(
						`❌ Error al enviar mini batch ${i + 1}:`,
						error.message || error
					);
					logger.error(
						`❌ Error en mini batch ${i + 1}: ${
							JSON.stringify(error.response?.data?.message, null, 2) ||
							error.message ||
							error
						}`
					);
				}
			}
		};

		const obtenerProductoPorSKU = async (sku) => {
			try {
				const producto = await retry(
					async (bail, attempt) => {
						try {
							const response = await wcApi.get("products", {
								sku,
							});

							logger.info(
								`✅ Consulta SKU "${sku}" completada (intento ${attempt})`
							);

							return response.data?.[0] || null;
						} catch (error) {
							const status = error.response?.status;
							const message = error.message?.toLowerCase() || "";

							if (status >= 400 && status < 500 && status !== 429) {
								bail(
									new Error(
										`Error no recuperable al obtener producto con SKU "${sku}": ${
											error.response?.data?.message || error.message
										}`
									)
								);
								return;
							}

							// Si es un error como 'socket hang up' o ECONNRESET, dejarlo pasar para retry
							if (
								error.code === "ECONNRESET" ||
								message.includes("socket hang up")
							) {
								logger.warn(
									`⚠️ Conexión reiniciada (socket hang up) al consultar SKU "${sku}", intento ${attempt}`
								);
							}

							throw error; // permite que retry maneje los reintentos
						}
					},
					{
						retries: 3,
						minTimeout: 1000,
						maxTimeout: 10000,
					}
				);

				return producto;
			} catch (error) {
				console.error(
					`❌ Error al obtener producto con SKU "${sku}":`,
					error.message || error
				);
				logger.error(
					`❌ Error al obtener producto con SKU "${sku}": ${
						JSON.stringify(error.response?.data?.message, null, 2) ||
						error.message ||
						error
					}`
				);
				return null;
			}
		};

		const cacheCategorias = new Map();
		const limit = pLimit(10);

		const chunks = chunkArray(productos, 20);

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

								console.log(`🔄 Obteniendo PDF desde SOAP: ${url}`);

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

							let existente = await obtenerProductoPorSKU(item.ART_CODIGO);

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

							if (existente && existente.id && existente.id > 0) {
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

		const categoriasCacheSize = cacheCategorias.size;
		logger.info(`🗂️ Categorías creadas o actualizadas: ${categoriasCacheSize}`);
		logger.info(
			`🗂️ Categorías cacheadas: ${Array.from(cacheCategorias.keys())
				.map((k) => k.split(" > ")[0])
				.join(", ")}`
		);

		const productosProcesadosSet = new Set(productos.map((p) => p.ART_CODIGO));

		await actualizarPreciosDesdeMetaData(cotizacion, productosProcesadosSet);

		const marcasWp = await obtenerTodasLasMarcas();
		await procesarMarcasWooDesdeSOAP(soapClient, marcasWp);

		const categorias = await obtenerTodasLasCategorias();
		await procesarImagenesCategorias(soapClient, categorias);

		logger.info("✅ Proceso de sincronización finalizado.");
	});
}

module.exports = { procesarProductos };
