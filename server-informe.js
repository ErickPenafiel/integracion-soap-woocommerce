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
const xml2js = require("xml2js");

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

async function obtenerRutaODocumentoDesdeSOAP(urlPathRaw) {
	const urlPath =
		typeof urlPathRaw === "string"
			? urlPathRaw
			: String(urlPathRaw?.url || urlPathRaw || "");

	const path = urlPathRaw;
	const match = path.match(/\\(\d+)\\/);
	let sku;

	if (match && match[1]) {
		sku = match[1];
	} else {
		console.log("No se encontró un ID válido.");
	}

	const soapEnvelope = `<?xml version="1.0" encoding="utf-8"?>
	<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
				   xmlns:xsd="http://www.w3.org/2001/XMLSchema"
				   xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
	  <soap:Body>
		<getWebfile xmlns="http://10.16.3.34:1600/servicebus.asmx">
		  <url_path>${urlPath}</url_path>
		</getWebfile>
	  </soap:Body>
	</soap:Envelope>`;

	try {
		const response = await retry(() =>
			axios.post(
				`${process.env.SOAP_URL}/servicebus.asmx`,
				soapEnvelope,
				{
					headers: {
						"Content-Type": "text/xml; charset=utf-8",
						SOAPAction: "http://10.16.3.34:1600/servicebus.asmx/getWebfile",
					},
					responseType: "arraybuffer",
					maxContentType: Infinity,
					maxBodyLength: Infinity,
					timeout: 15000,
				},
				3,
				2000
			)
		);

		const contentType = response.headers["content-type"] || "";
		const rawBuffer = Buffer.from(response.data);

		// Si el contenido es PDF, devolvemos un objeto con tipo y buffer
		if (
			contentType.includes("application/pdf") ||
			rawBuffer.slice(0, 4).toString() === "%PDF"
		) {
			return { tipo: "pdf", data: rawBuffer };
		} else {
			// Si no es PDF, probablemente sea una ruta
			const rawString = rawBuffer.toString("utf-8");
			const parsed = await xml2js.parseStringPromise(rawString, {
				explicitArray: false,
			});

			const ruta =
				parsed?.["soap:Envelope"]?.["soap:Body"]?.["getWebfileResponse"]?.[
					"getWebfileResult"
				] ||
				parsed?.["soap:Envelope"]?.["soap:Body"]?.["getWebfileResponse"]?.[
					"string"
				];

			if (!ruta) {
				logger.error("❌ No se encontró la ruta en el XML.");
				return { tipo: "error", data: null };
			} else {
				logger.info(`📂 Ruta encontrada: ${ruta}`);
				return { tipo: "ruta", data: ruta };
			}
		}
	} catch (err) {
		logger.error(
			`❌ Error al obtener PDF desde SOAP ${sku} ${urlPathRaw}: ${
				err.message || err
			}`
		);
		return { tipo: "error", data: null };
	}
}

function chunkArray(array, size) {
	const result = [];
	for (let i = 0; i < array.length; i += size) {
		result.push(array.slice(i, i + size));
	}
	return result;
}

async function procesarProductos() {
	soap.createClient(soapUrl, options, async function (err, soapClient) {
		if (err) {
			return console.error("Error al crear el cliente SOAP:", err);
		}

		const args = {};

		// 1. Obtener productos desde SOAP
		// const result = await new Promise((resolve, reject) => {
		// 	soapClient.servicebus.servicebusSoap12.getWebProductos(
		// 		args,
		// 		(err, result) => {
		// 			if (err) return reject(err);
		// 			resolve(result);
		// 		}
		// 	);
		// });

		// const diffgram = result.getWebProductosResult.diffgram;
		// if (!diffgram || !diffgram.NewDataSet || !diffgram.NewDataSet.Table) {
		// 	return console.error("No se encontraron productos en la respuesta SOAP.");
		// }

		// let productos = diffgram.NewDataSet.Table;
		const productos = require("./productos-all-11.json");

		if (!Array.isArray(productos)) {
			productos = [productos];
		}
		// const skuInicio = "46450300248";
		// const indiceInicio = productos.findIndex((p) => p.ART_CODIGO === skuInicio);

		// if (indiceInicio !== -1) {
		// 	productos = productos.slice(0, 10);
		// 	logger.info(
		// 		`🔁 Empezando integración desde SKU ${skuInicio} (índice ${indiceInicio})`
		// 	);
		// } else {
		// 	logger.warn(
		// 		`⚠️ SKU ${skuInicio} no encontrado. Procesando todos los productos.`
		// 	);
		// }
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

		const chunkArray = (array, size) => {
			const result = [];
			for (let i = 0; i < array.length; i += size) {
				result.push(array.slice(i, i + size));
			}
			return result;
		};

		const limit = pLimit(10);
		const chunks = chunkArray(productos, 20);

		for (const chunk of chunks) {
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

								if (
									imagenBase64 &&
									!imagenBase64.startsWith("C:") &&
									!imagenBase64.startsWith("\\")
								) {
									item.isValid_IMAGEN_PRIMARIA = true;
								} else {
									item.isValid_IMAGEN_PRIMARIA = false;
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

								if (
									imagenBase64 &&
									!imagenBase64.startsWith("C:") &&
									!imagenBase64.startsWith("\\")
								) {
									// const imageUrl = await subirImagenDesdeBase64(imagenBase64);
									// if (imageUrl) imagenes.push({ src: imageUrl });

									item.isValid_IMAGEN_SECUNDARIA = true;
								} else {
									item.isValid_IMAGEN_SECUNDARIA = false;
								}
							}

							if (item.URL_IMAGEN_3 && item.URL_IMAGEN_3.includes(".")) {
								const ext = item.URL_IMAGEN_3.split(".").pop();
								const imagenBase64 = await intentarObtenerImagen(
									soapClient,
									item.URL_IMAGEN_3,
									ext
								);

								if (
									imagenBase64 &&
									!imagenBase64.startsWith("C:") &&
									!imagenBase64.startsWith("\\")
								) {
									// const imageUrl = await subirImagenDesdeBase64(imagenBase64);
									// if (imageUrl) imagenes.push({ src: imageUrl });

									item.isValid_IMAGEN_3 = true;
								} else {
									item.isValid_IMAGEN_3 = false;
								}
							}

							if (item.URL_IMAGEN_4 && item.URL_IMAGEN_4.includes(".")) {
								const ext = item.URL_IMAGEN_4.split(".").pop();
								const imagenBase64 = await intentarObtenerImagen(
									soapClient,
									item.URL_IMAGEN_4,
									ext
								);

								if (
									imagenBase64 &&
									!imagenBase64.startsWith("C:") &&
									!imagenBase64.startsWith("\\")
								) {
									// const imageUrl = await subirImagenDesdeBase64(imagenBase64);
									// if (imageUrl) imagenes.push({ src: imageUrl });
									item.isValid_IMAGEN_4 = true;
								} else {
									item.isValid_IMAGEN_4 = false;
								}
							}

							if (item.URL_IMAGEN_5 && item.URL_IMAGEN_5.includes(".")) {
								const ext = item.URL_IMAGEN_5.split(".").pop();
								const imagenBase64 = await intentarObtenerImagen(
									soapClient,
									item.URL_IMAGEN_5,
									ext
								);

								if (
									imagenBase64 &&
									!imagenBase64.startsWith("C:") &&
									!imagenBase64.startsWith("\\")
								) {
									// const imageUrl = await subirImagenDesdeBase64(imagenBase64);
									// if (imageUrl) imagenes.push({ src: imageUrl });
									item.isValid_IMAGEN_5 = true;
								} else {
									item.isValid_IMAGEN_5 = false;
								}
							}

							if (item.URL_IMAGEN_6 && item.URL_IMAGEN_6.includes(".")) {
								const ext = item.URL_IMAGEN_6.split(".").pop();
								const imagenBase64 = await intentarObtenerImagen(
									soapClient,
									item.URL_IMAGEN_6,
									ext
								);

								if (
									imagenBase64 &&
									!imagenBase64.startsWith("C:") &&
									!imagenBase64.startsWith("\\")
								) {
									// const imageUrl = await subirImagenDesdeBase64(imagenBase64);
									// if (imageUrl) imagenes.push({ src: imageUrl });

									item.isValid_IMAGEN_6 = true;
								} else {
									item.isValid_IMAGEN_6 = false;
								}
							}

							if (item.URL_IMAGEN_7 && item.URL_IMAGEN_7.includes(".")) {
								const ext = item.URL_IMAGEN_7.split(".").pop();
								const imagenBase64 = await intentarObtenerImagen(
									soapClient,
									item.URL_IMAGEN_7,
									ext
								);

								if (
									imagenBase64 &&
									!imagenBase64.startsWith("C:") &&
									!imagenBase64.startsWith("\\")
								) {
									item.isValid_IMAGEN_7 = true;
								} else {
									item.isValid_IMAGEN_7 = false;
								}
							}

							async function obtenerPDFConCache(url) {
								if (!url) return null;
								if (cacheBuffersPDF.has(url)) return cacheBuffersPDF.get(url);

								console.log(`🔄 Obteniendo PDF desde SOAP: ${url}`);

								const buffer = await obtenerRutaODocumentoDesdeSOAP(url);
								if (buffer.tipo === "error") {
									if (url.includes("DOCUMENTOS")) {
										item.isValid_URL_DOCUMENTOS = false;
									} else if (url.includes("FICHA_TECNICA")) {
										item.isValid_URL_FICHA_TECNICA = false;
									} else if (url.includes("DIMENSIONAL")) {
										item.isValid_URL_DIMENSIONAL = false;
									}
								} else {
									if (url.includes("DOCUMENTOS")) {
										item.isValid_URL_DOCUMENTOS = true;
									} else if (url.includes("FICHA_TECNICA")) {
										item.isValid_URL_FICHA_TECNICA = true;
									} else if (url.includes("DIMENSIONAL")) {
										item.isValid_URL_DIMENSIONAL = true;
									}
								}
								if (buffer) cacheBuffersPDF.set(url, buffer);

								return buffer;
							}

							const pdfBuffer = await obtenerPDFConCache(item.URL_DOCUMENTOS);

							// const pdf = pdfBuffer
							// 	? await subirPDFaWordPress(pdfBuffer, item.ART_CODIGO)
							// 	: null;

							const fichaTecnicaBuffer = await obtenerPDFConCache(
								item.URL_FICHA_TECNICA
							);

							// const fichaTecnica = fichaTecnicaBuffer
							// 	? await subirPDFaWordPress(fichaTecnicaBuffer, item.ART_CODIGO)
							// 	: null;

							const dimensionalBuffer = await obtenerPDFConCache(
								item.URL_DIMENSIONAL
							);

							// const dimensional = dimensionalBuffer
							// 	? await subirPDFaWordPress(dimensionalBuffer, item.ART_CODIGO)
							// 	: null;
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
		}

		// Exportar el array productos a un archivo JSON
		const filePath = path.join(__dirname, "productos_imagenes.json");
		fs.writeFileSync(filePath, JSON.stringify(productos, null, 2));

		logger.info("✅ Proceso de sincronización finalizado.");
	});
}

app.get("/integrar", async (req, res) => {
	// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	dns.lookup(hostname, (err, address, family) => {
		if (err) throw err;
		console.log(`IP de ${hostname}: ${address}`);
	});

	procesarProductos();
	res.send("Proceso de integración iniciado.");
});

app.get("/actualizar-manage-stock", async (req, res) => {
	actualizarManageStockFalseParaTodos();
	res.send("Proceso de actualización de manage_stock iniciado.");
});

app.listen(port, () => {
	console.log(`Servidor Express escuchando en http://localhost:${port}`);
});
