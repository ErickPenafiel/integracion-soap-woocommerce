require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const xml2js = require("xml2js");
const crypto = require("crypto");

async function obtenerImagenDesdeSOAP(soapClient, urlPath) {
	if (!urlPath) return null; // Si no hay imagen, retornar null

	return new Promise((resolve, reject) => {
		soapClient.servicebus.servicebusSoap12.getWebfile(
			{ url_path: urlPath },
			function (err, result) {
				if (err) {
					console.error("Error al obtener la imagen:", err);
					return resolve(null);
				}

				if (result && result.getWebfileResult) {
					resolve(result.getWebfileResult);
				} else {
					resolve(null);
				}
			}
		);
	});
}

async function obtenerPDFDesdeSOAP(urlPathRaw) {
	const urlPath =
		typeof urlPathRaw === "string"
			? urlPathRaw
			: String(urlPathRaw?.url || urlPathRaw || "");

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
		const response = await axios.post(
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
				console.error("❌ No se encontró la ruta en el XML.");
				return null;
			}

			console.log("📂 Ruta encontrada (no se sube):", ruta);
			return null; // No se sube si es una ruta local
		}
	} catch (err) {
		console.error("❌ Error al obtener PDF desde SOAP:", err.message || err);
		return null;
	}
}

async function obtenerPDFBufferDesdeSOAP(urlPathRaw) {
	const urlPath =
		typeof urlPathRaw === "string"
			? urlPathRaw
			: String(urlPathRaw?.url || urlPathRaw || "");

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
		const response = await axios.post(
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
				console.error("❌ No se encontró la ruta en el XML.");
			} else {
				console.log("📂 Ruta encontrada (no se sube):", ruta);
			}

			return null;
		}
	} catch (err) {
		console.error("❌ Error al obtener PDF desde SOAP:", err.message || err);
		return null;
	}
}

module.exports = {
	obtenerImagenDesdeSOAP,
	obtenerPDFDesdeSOAP,
	obtenerPDFBufferDesdeSOAP,
};
