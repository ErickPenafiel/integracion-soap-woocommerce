require("dotenv").config();

const express = require("express");
const soap = require("soap");
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");
const WPAPI = require("wpapi");
const xml2js = require("xml2js");

const app = express();
const port = 5000;

const wp = new WPAPI({
	endpoint: `${process.env.WC_URL}`,
	username: process.env.WP_USER,
	password: process.env.WP_PASS,
});

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

const soapUrl = process.env.SOAP_URL;

async function procesarProductos() {
	soap.createClient(soapUrl, function (err, soapClient) {
		if (err) {
			return console.error("Error al crear el cliente SOAP:", err);
		}

		// console.log("Cliente SOAP creado. Llamando al servicio...");
		// console.log(soapClient.describe());
		const args = {};

		// console.log(soapClient.describe().servicebus.servicebusSoap12.getWebfile);

		soapClient.servicebus.servicebusSoap12.getWebProductos(
			args,
			async function (err, result) {
				if (err) {
					return console.error("Error en la llamada SOAP:", err);
				}

				console.log("Resultado SOAP recibido.");

				const diffgram = result.getWebProductosResult.diffgram;
				if (!diffgram || !diffgram.NewDataSet || !diffgram.NewDataSet.Table) {
					return console.error(
						"No se encontraron productos en la respuesta SOAP."
					);
				}

				let productos = diffgram.NewDataSet.Table;
				if (!Array.isArray(productos)) {
					productos = [productos];
				}

				console.log("Productos obtenidos:", productos.length);

				for (let item of productos) {
					const imagenes = [];
					const pdfs = [];

					const imagenBase64 = await obtenerImagenDesdeSOAP(
						soapClient,
						item.URL_IMAGEN_PRIMARIA
					);

					if (imagenBase64 && !imagenBase64.startsWith("C:")) {
						console.log("Imagen base64 obtenida");
						const imageUrl = await subirImagenDesdeBase64(
							imagenBase64,
							`img_${item.ART_CODIGO}`
						);
						if (imageUrl) {
							imagenes.push({ src: imageUrl });
						}
					} else {
						console.log("Imagen no válida o no encontrada");
					}

					const pdf = await obtenerPDFDesdeSOAP(item.URL_DOCUMENTOS);

					if (pdf) {
						console.log("PDF obtenido:", pdf);
						pdfs.push({ src: pdf });
					} else {
						console.log("PDF no válido o no encontrado");
					}

					const productoWoo = {
						name: item.ART_DESCRIPCION || "Producto SOAP sin nombre",
						type: "simple",
						regular_price: item.PREC_WEB || "0",
						sku: item.ART_CODIGO || "",
						description: item.ART_DESCRIPCION || "",

						images: imagenes,

						// ⚠️ Categorías: filtra null/undefined/"NULL"
						categories: [
							item.CATEGORIA,
							item.FAMILIA,
							item.FAMILIA_NIVEL1,
							item.FAMILIA_NIVEL2,
							item.FAMILIA_NIVEL3,
							item.FAMILIA_NIVEL4,
							item.FAMILIA_NIVEL5,
							item.FAMILIA_NIVEL6,
							item.FAMILIA_NIVEL7,
						]
							.filter((c) => c && c !== "NULL")
							.map((name) => ({ name })),

						// ⚠️ Etiquetas: filtramos SIN;DATOS y tags vacíos
						tags:
							item.ETIQUETAS && !item.ETIQUETAS.includes("SIN")
								? item.ETIQUETAS.split(";")
										.map((tag) => tag.trim())
										.filter((tag) => tag && tag !== "DATOS")
										.map((name) => ({ name }))
								: [],

						// ⚠️ Marca como atributo si existe
						attributes:
							item.MARCA && item.MARCA !== "SIN"
								? [
										{
											name: "Marca",
											options: [item.MARCA],
										},
								  ]
								: [],

						// ⚠️ Dimensiones si tienen valores válidos
						dimensions:
							parseFloat(item.ALTO_CM) > 0 ||
							parseFloat(item.ANCHO_CM) > 0 ||
							parseFloat(item.PROFUNDIDAD_CM) > 0
								? {
										length: item.PROFUNDIDAD_CM || "0",
										width: item.ANCHO_CM || "0",
										height: item.ALTO_CM || "0",
								  }
								: undefined,

						// ⚠️ Peso
						weight:
							parseFloat(item.PESO_KG) > 0
								? item.PESO_KG.toString()
								: undefined,

						// ⚠️ Stock
						manage_stock: true,
						stock_quantity: Number.isFinite(Number(item.TOT_EXIST))
							? parseInt(item.TOT_EXIST)
							: 0,

						// ⚠️ Meta campos adicionales
						meta_data: [
							{
								key: "manual",
								value: pdfs,
							},
							...(item.UNIDAD_MEDIDA
								? [
										{
											key: "unidad_medida",
											value: item.UNIDAD_MEDIDA,
										},
								  ]
								: []),
							...(item.DATOS_TECNICOS && item.DATOS_TECNICOS !== "SIN DATOS"
								? [
										{
											key: "datos_tecnicos",
											value: item.DATOS_TECNICOS,
										},
								  ]
								: []),
							...(item.SUSTITUTO && item.SUSTITUTO !== "0"
								? [
										{
											key: "sustituto",
											value: item.SUSTITUTO,
										},
								  ]
								: []),
						],
					};

					try {
						const responseGet = await wcApi.get("products", {
							sku: productoWoo.sku,
						});
						let productosExistentes = responseGet.data;

						if (productosExistentes && productosExistentes.length > 0) {
							let productoExistente = productosExistentes[0];
							await wcApi.put(`products/${productoExistente.id}`, productoWoo);
							console.log(`Producto con SKU ${productoWoo.sku} actualizado.`);
						} else {
							await wcApi.post("products", productoWoo);
							console.log(`Producto con SKU ${productoWoo.sku} creado.`);
						}
					} catch (error) {
						console.error(
							`Error al procesar producto con SKU ${productoWoo.sku}:`,
							error.response ? error.response.data : error
						);
					}
				}
			}
		);
	});
}

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
					resolve(result.getWebfileResult); // Puede ser una URL o base64
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

async function subirImagenDesdeBase64(base64, nombre = "imagen") {
	try {
		let mimeType = "image/webp";
		let data = base64;

		const matches = base64.match(/^data:(image\/\w+);base64,(.+)$/);
		if (matches) {
			mimeType = matches[1];
			data = matches[2];
		}

		const fileName = `${nombre}.webp`;
		const tempPath = path.join(__dirname, fileName);

		fs.writeFileSync(tempPath, Buffer.from(data, "base64"));

		const fileStream = fs.createReadStream(tempPath);
		const form = new FormData();
		form.append("file", fileStream, fileName);

		const response = await axios.post(
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

		fs.unlinkSync(tempPath);

		console.log("✅ Imagen subida con éxito:", response.data.source_url);
		return response.data.source_url;
	} catch (error) {
		console.error(
			"❌ Error al subir la imagen:",
			error.response?.data || error.message
		);
		return null;
	}
}

// cron.schedule("*/30 * * * *", () => {
// 	console.log("Ejecutando cron job: procesando productos.");
// 	procesarProductos();
// });

// cron.schedule("0 */6 * * *", () => {
// 	console.log("Ejecutando cron job cada 6 horas: procesando productos.");
// 	procesarProductos();
// });

app.get("/integrar", (req, res) => {
	procesarProductos();
	res.send("Proceso de integración iniciado.");
});

app.listen(port, () => {
	console.log(`Servidor Express escuchando en http://localhost:${port}`);
});
