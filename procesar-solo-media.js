// solo-media-sync.js
require("dotenv").config();

const soap = require("soap");
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const pLimit = require("p-limit");
const retry = require("async-retry");
const _ = require("lodash");

const logger = require("./src/services/logger");
const { intentarObtenerImagen } = require("./helpers/images");
const {
	subirImagenDesdeBase64,
	subirPDFaWordPress,
} = require("./src/services/wp-service");
const { obtenerPDFBufferDesdeSOAP } = require("./src/services/soap-service");

const { construirActualizacionImagenesYPdfs } = require("./helpers/products");

// ============================================
// Config
// ============================================
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
const options = { timeout: 300000 };

// ============================================
// Utils
// ============================================
function chunkArray(array, size) {
	const result = [];
	for (let i = 0; i < array.length; i += size) {
		result.push(array.slice(i, i + size));
	}
	return result;
}

async function crearSoapClient() {
	return new Promise((resolve, reject) => {
		soap.createClient(soapUrl, options, (err, client) => {
			if (err) return reject(err);
			resolve(client);
		});
	});
}

async function obtenerProductoPorSKU(sku) {
	try {
		const producto = await retry(
			async (bail, attempt) => {
				try {
					const response = await wcApi.get("products", { sku });
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

					// errores de conexión intermitentes → permitir reintento
					if (
						error.code === "ECONNRESET" ||
						message.includes("socket hang up")
					) {
						logger.warn(
							`⚠️ Conexión reiniciada (socket hang up) al consultar SKU "${sku}", intento ${attempt}`
						);
					}
					throw error;
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
		logger.error(
			`❌ Error al obtener producto con SKU "${sku}": ${
				JSON.stringify(error.response?.data?.message, null, 2) ||
				error.message ||
				error
			}`
		);
		return null;
	}
}

function normalizarCampoRuta(valor) {
	if (!valor || typeof valor !== "string") return null;
	const v = valor.trim();
	if (!v || v.toUpperCase() === "NULL") return null;
	return v;
}

function esRutaValidaDeImagen(ruta) {
	if (!ruta) return false;
	const lower = ruta.toLowerCase();
	// evitar rutas locales de windows y cadenas sin extensión
	if (lower.startsWith("c:")) return false;
	return (
		lower.endsWith(".jpg") ||
		lower.endsWith(".jpeg") ||
		lower.endsWith(".png") ||
		lower.endsWith(".webp") ||
		lower.endsWith(".gif")
	);
}

function esRutaValidaDePDF(ruta) {
	if (!ruta) return false;
	const lower = ruta.toLowerCase();
	if (lower.startsWith("c:")) return false;
	return lower.endsWith(".pdf");
}

function extraerExtension(ruta) {
	if (!ruta || !ruta.includes(".")) return null;
	return ruta.split(".").pop().toLowerCase();
}

function arraysDeSrcSonIgualesOrdenEstricto(a = [], b = []) {
	const as = (a || []).map((x) => x?.src).filter(Boolean);
	const bs = (b || []).map((x) => x?.src).filter(Boolean);
	return _.isEqual(as, bs); // respeta orden (importa para galería)
}

function getMetaValor(metaArray = [], key) {
	if (!Array.isArray(metaArray)) return null;
	const entry = metaArray.find((m) => m && m.key === key);
	return entry ? entry.value : null;
}

async function enviarBatchActualizaciones(actualizar, batchSize = 20) {
	const actualizarChunks = chunkArray(actualizar, batchSize);

	for (let i = 0; i < actualizarChunks.length; i++) {
		const miniActualizar = actualizarChunks[i] || [];
		if (miniActualizar.length === 0) continue;

		try {
			await retry(
				async (bail, attempt) => {
					try {
						const response = await wcApi.post("products/batch", {
							update: miniActualizar,
						});

						if (response.data.errors && response.data.errors.length > 0) {
							logger.error("❌ Errores detectados en batch UPDATE:");
							logger.error(JSON.stringify(response.data.errors, null, 2));
						}

						const updated = (response.data.update || []).map((item) => ({
							id: item.id,
							name: item.name,
							permalink: item.permalink,
						}));

						logger.info(
							`✅ Batch ${i + 1}/${
								actualizarChunks.length
							} (intento ${attempt}) actualizado: ${updated.length}`
						);

						if (attempt > 1) {
							logger.info(
								`🔁 Batch ${
									i + 1
								} completado correctamente después de reintento #${attempt}`
							);
						}
					} catch (error) {
						if (error.response?.status >= 400 && error.response?.status < 500) {
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
				{ retries: 3, minTimeout: 1000, maxTimeout: 300000 }
			);
		} catch (error) {
			logger.error(
				`❌ Error al enviar mini batch ${i + 1}: ${
					JSON.stringify(error.response?.data?.message, null, 2) ||
					error.message ||
					error
				}`
			);
		}
	}
}

// ============================================
// CACHES
// ============================================
const cacheBufferPDF = new Map(); // ruta PDF -> Buffer
const cacheURLPDFSubido = new Map(); // ruta PDF -> URL en WP

async function obtenerPDFConCache(ruta) {
	if (!esRutaValidaDePDF(ruta)) return null;

	if (cacheURLPDFSubido.has(ruta)) {
		return { buffer: null, url: cacheURLPDFSubido.get(ruta) };
	}

	let buffer = cacheBufferPDF.get(ruta);
	if (!buffer) {
		logger.info(`🔄 Descargando PDF desde SOAP: ${ruta}`);
		buffer = await obtenerPDFBufferDesdeSOAP(ruta);
		if (buffer) cacheBufferPDF.set(ruta, buffer);
	}

	return { buffer, url: null };
}

async function procesarSoloMedia() {
	const soapClient = await crearSoapClient();

	const result = await new Promise((resolve, reject) => {
		soapClient.servicebus.servicebusSoap12.getWebProductos_docs(
			{},
			(err, result) => {
				if (err) return reject(err);
				resolve(result);
			}
		);
	});

	let productos = [];
	const diffgram = result?.getWebProductos_docsResult?.diffgram;
	if (!diffgram || !diffgram.NewDataSet || !diffgram.NewDataSet.Table) {
		logger.error("No se encontraron productos en la respuesta SOAP.");
		productos = [];
	} else {
		productos = diffgram.NewDataSet.Table;
		if (!Array.isArray(productos)) productos = [productos];
	}

	logger.info(`📦 Productos obtenidos desde SOAP: ${productos.length}`);

	const limit = pLimit(3);
	const chunks = chunkArray(productos, 20);

	for (const chunk of chunks) {
		const productosParaActualizar = [];

		await Promise.all(
			chunk.map((item) =>
				limit(async () => {
					try {
						const sku = (item.ART_CODIGO || "").toString().trim();
						if (!sku) {
							logger.warn("⚠️ Producto sin ART_CODIGO. Omitido.");
							return;
						}

						// =========================
						// 1) IMÁGENES
						// =========================
						const candidatosImg = [
							normalizarCampoRuta(item.URL_IMAGEN_PRIMARIA),
							normalizarCampoRuta(item.URL_IMAGEN_SECUNDARIA),
							normalizarCampoRuta(item.URL_IMAGEN_3),
							normalizarCampoRuta(item.URL_IMAGEN_4),
							normalizarCampoRuta(item.URL_IMAGEN_5),
							normalizarCampoRuta(item.URL_IMAGEN_6),
							normalizarCampoRuta(item.URL_IMAGEN_7),
						].filter(esRutaValidaDeImagen);

						const nuevasImagenes = [];
						for (const ruta of candidatosImg) {
							const ext = extraerExtension(ruta);
							try {
								const base64 = await intentarObtenerImagen(
									soapClient,
									ruta,
									ext
								);
								if (base64 && !base64.toUpperCase().startsWith("C:")) {
									const imageUrl = await subirImagenDesdeBase64(base64);
									if (imageUrl) nuevasImagenes.push({ src: imageUrl });
								}
							} catch (e) {
								logger.warn(
									`SKU ${sku}: fallo al procesar imagen "${ruta}": ${
										e.message || e
									}`
								);
							}
						}

						const imagenesDedup = _.uniqBy(nuevasImagenes, "src");

						// =========================
						// 2) PDFs
						// =========================
						// manual
						const rutaManual = normalizarCampoRuta(item.URL_DOCUMENTOS);
						let manualUrl = null;
						if (esRutaValidaDePDF(rutaManual)) {
							try {
								const { buffer, url } = await obtenerPDFConCache(rutaManual);
								if (url) {
									manualUrl = url;
								} else if (buffer) {
									const subido = await subirPDFaWordPress(buffer, sku);
									if (subido) {
										cacheURLPDFSubido.set(rutaManual, subido);
										manualUrl = subido;
									}
								}
							} catch (e) {
								logger.warn(
									`SKU ${sku}: fallo al procesar PDF manual "${rutaManual}": ${
										e.message || e
									}`
								);
							}
						}

						// ficha técnica
						const rutaFicha = normalizarCampoRuta(item.URL_FICHA_TECNICA);
						let fichaUrl = null;
						if (esRutaValidaDePDF(rutaFicha)) {
							try {
								const { buffer, url } = await obtenerPDFConCache(rutaFicha);
								if (url) {
									fichaUrl = url;
								} else if (buffer) {
									const subido = await subirPDFaWordPress(buffer, sku);
									if (subido) {
										cacheURLPDFSubido.set(rutaFicha, subido);
										fichaUrl = subido;
									}
								}
							} catch (e) {
								logger.warn(
									`SKU ${sku}: fallo al procesar PDF ficha "${rutaFicha}": ${
										e.message || e
									}`
								);
							}
						}

						// dimensional
						const rutaDim = normalizarCampoRuta(item.URL_DIMENSIONAL);
						let dimensionalUrl = null;
						if (esRutaValidaDePDF(rutaDim)) {
							try {
								const { buffer, url } = await obtenerPDFConCache(rutaDim);
								if (url) {
									dimensionalUrl = url;
								} else if (buffer) {
									const subido = await subirPDFaWordPress(buffer, sku);
									if (subido) {
										cacheURLPDFSubido.set(rutaDim, subido);
										dimensionalUrl = subido;
									}
								}
							} catch (e) {
								logger.warn(
									`SKU ${sku}: fallo al procesar PDF dimensional "${rutaDim}": ${
										e.message || e
									}`
								);
							}
						}

						// =========================
						// 3) BUSCAR EXISTENTE Y COMPARAR
						// =========================
						const existente = await obtenerProductoPorSKU(sku);
						if (!existente || !existente.id) {
							logger.warn(
								`SKU ${sku}: producto no existe en WooCommerce. Omitido.`
							);
							return;
						}

						// Comparar imágenes
						const actualesImgs = (existente.images || []).map((img) => ({
							src: img.src,
						}));
						const hayCambioImgs =
							imagenesDedup.length > 0 &&
							!arraysDeSrcSonIgualesOrdenEstricto(actualesImgs, imagenesDedup);

						// Comparar PDFs
						const meta = existente.meta_data || [];
						const actualManual = getMetaValor(meta, "manual");
						const actualFicha = getMetaValor(meta, "fichatecnica");
						const actualDim = getMetaValor(meta, "dimensional");

						// Solo consideramos cambio si tenemos una NUEVA URL y difiere de la actual.
						const manualParaSetear =
							manualUrl && manualUrl !== actualManual ? manualUrl : null;
						const fichaParaSetear =
							fichaUrl && fichaUrl !== actualFicha ? fichaUrl : null;
						const dimensionalParaSetear =
							dimensionalUrl && dimensionalUrl !== actualDim
								? dimensionalUrl
								: null;

						const hayCambioPDFs = Boolean(
							manualParaSetear || fichaParaSetear || dimensionalParaSetear
						);

						if (!hayCambioImgs && !hayCambioPDFs) {
							logger.info(`SKU ${sku}: medios ya están actualizados. Omitido.`);
							return;
						}

						// =========================
						// 4) ARMAR PAYLOAD SOLO MEDIA
						// =========================
						const payload = construirActualizacionImagenesYPdfs(
							existente.id,
							hayCambioImgs ? imagenesDedup : undefined,
							manualParaSetear || undefined,
							fichaParaSetear || undefined,
							dimensionalParaSetear || undefined
						);

						console.log({
							payload,
							images: payload.images,
							metadata: payload.meta_data,
						});

						productosParaActualizar.push(payload);

						const partes = [
							hayCambioImgs ? `imagenes=${imagenesDedup.length}` : null,
							manualParaSetear ? "manual=ok" : null,
							fichaParaSetear ? "fichatecnica=ok" : null,
							dimensionalParaSetear ? "dimensional=ok" : null,
						]
							.filter(Boolean)
							.join(", ");

						logger.info(
							`🖼️📄 SKU ${sku}: marcado para actualizar (${partes}).`
						);
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

		if (productosParaActualizar.length > 0) {
			await enviarBatchActualizaciones(productosParaActualizar);
			await new Promise((r) => setTimeout(r, 3000)); // respiro entre lotes
		}
	}

	logger.info("✅ Proceso de actualización de imágenes y PDFs finalizado.");
}

module.exports = { procesarSoloMedia };
