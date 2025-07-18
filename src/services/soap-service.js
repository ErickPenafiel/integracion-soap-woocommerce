require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const xml2js = require("xml2js");
const crypto = require("crypto");
const logger = require("./logger");
const retry = require("async-retry");

// async function retry(fn, retries = 3, delay = 1000) {
// 	for (let i = 0; i < retries; i++) {
// 		try {
// 			return await fn();
// 		} catch (err) {
// 			const isLastAttempt = i === retries - 1;
// 			const isRetryable =
// 				err.code === "ETIMEDOUT" ||
// 				err.code === "ECONNRESET" ||
// 				err.code === "ECONNABORTED";

// 			if (isLastAttempt || !isRetryable) throw err;

// 			console.warn(
// 				`🔁 Reintentando (${i + 1}/${retries}) después de error: ${err.code}`
// 			);
// 			await new Promise((res) => setTimeout(res, delay));
// 		}
// 	}
// }

async function obtenerImagenDesdeSOAP(soapClient, urlPath) {
	if (!urlPath) return null;

	const match = urlPath.match(/\\(\d+)\\/);
	const sku = match?.[1] || "desconocido";

	try {
		const result = await retry(
			async (bail, attempt) => {
				logger.info(`🔁 Intento #${attempt} para obtener imagen SKU ${sku}`);

				return await new Promise((resolve, reject) => {
					soapClient.servicebus.servicebusSoap12.getWebfile(
						{ url_path: urlPath },
						(err, result) => {
							if (err) return reject(err);
							resolve(result?.getWebfileResult ?? null);
						}
					);
				});
			},
			{
				retries: 3,
				minTimeout: 2000,
				onRetry: (err, attempt) => {
					logger.warn(`⚠️ Reintentando imagen SKU ${sku}: ${err.message}`);
				},
			}
		);

		return result;
	} catch (err) {
		logger.error(
			`❌ Error al obtener la imagen SKU ${sku} (${urlPath}): ${
				err.message || err
			}`
		);
		return null;
	}
}

async function obtenerPDFDesdeSOAP(urlPathRaw) {
	const urlPath =
		typeof urlPathRaw === "string"
			? urlPathRaw
			: String(urlPathRaw?.url || urlPathRaw || "");

	const pathInput = urlPathRaw;
	const match = pathInput.match(/\\(\d+)\\/);
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
		const response = await retry(
			async (bail, attempt) => {
				logger.info(`🔁 Intento #${attempt} de descarga SOAP para SKU ${sku}`);
				try {
					return await axios.post(
						`${process.env.SOAP_URL}/servicebus.asmx`,
						soapEnvelope,
						{
							headers: {
								"Content-Type": "text/xml; charset=utf-8",
								SOAPAction: "http://10.16.3.34:1600/servicebus.asmx/getWebfile",
							},
							responseType: "arraybuffer",
							maxContentLength: Infinity,
							maxBodyLength: Infinity,
							timeout: 15000,
						}
					);
				} catch (error) {
					if (error.response && error.response.status < 500) {
						// Error de cliente (4xx), no tiene sentido reintentar
						bail(error);
					}
					throw error; // Reintenta en errores 5xx u otros
				}
			},
			{
				retries: 3,
				minTimeout: 2000,
			}
		);

		const contentType = response.headers["content-type"] || "";
		console.log("Tipo de contenido:", contentType);

		const rawBuffer = Buffer.from(response.data);

		if (
			contentType.includes("application/pdf") ||
			rawBuffer.slice(0, 4).toString() === "%PDF"
		) {
			const fileName = `manual_${Date.now()}.pdf`;
			const filePath = path.join(__dirname, fileName);

			fs.writeFileSync(filePath, rawBuffer);

			const fileStream = fs.createReadStream(filePath);
			const form = new FormData();
			form.append("file", fileStream, fileName);

			const uploadResponse = await axios.post(
				`${process.env.WC_URL}/wp-json/wp/v2/media`,
				form,
				{
					headers: {
						...form.getHeaders(),
						Authorization:
							"Basic " +
							Buffer.from(
								`${process.env.WP_USER}:${process.env.WP_PASS}`
							).toString("base64"),
					},
				}
			);

			fs.unlinkSync(filePath);
			console.log("✅ PDF subido con éxito:", uploadResponse.data.source_url);
			return uploadResponse.data.source_url;
		} else {
			// 🧾 Es XML con una ruta
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
				return null;
			}

			logger.info(`📂 Ruta encontrada (no se sube): ${ruta}`);
			return null;
		}
	} catch (err) {
		logger.error(
			`❌ Error al obtener PDF desde SOAP para SKU ${sku} con URL ${urlPathRaw}: ${
				err.message || err
			}`
		);
		return null;
	}
}

async function obtenerPDFBufferDesdeSOAP(urlPathRaw) {
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
		const response = await retry(
			async (bail, attempt) => {
				logger.info(`🔁 Intento #${attempt} para obtener PDF SKU ${sku}`);
				try {
					return await axios.post(
						`${process.env.SOAP_URL}/servicebus.asmx`,
						soapEnvelope,
						{
							headers: {
								"Content-Type": "text/xml; charset=utf-8",
								SOAPAction: "http://10.16.3.34:1600/servicebus.asmx/getWebfile",
							},
							responseType: "arraybuffer",
							maxContentLength: Infinity,
							maxBodyLength: Infinity,
							timeout: 15000,
						}
					);
				} catch (error) {
					if (error.response && error.response.status < 500) {
						// Error de cliente (4xx): no reintentar
						bail(error);
					}
					throw error;
				}
			},
			{
				retries: 3,
				minTimeout: 2000,
			}
		);

		const contentType = response.headers["content-type"] || "";
		const rawBuffer = Buffer.from(response.data);

		if (
			contentType.includes("application/pdf") ||
			rawBuffer.slice(0, 4).toString() === "%PDF"
		) {
			return rawBuffer;
		} else {
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
			} else {
				logger.info(`📂 Ruta encontrada (no se sube): ${ruta}`);
			}

			return null;
		}
	} catch (err) {
		logger.error(
			`❌ Error al obtener PDF desde SOAP SKU ${sku} ${urlPathRaw}: ${
				err.message || err
			}`
		);
		return null;
	}
}

module.exports = {
	obtenerImagenDesdeSOAP,
	obtenerPDFDesdeSOAP,
	obtenerPDFBufferDesdeSOAP,
};
