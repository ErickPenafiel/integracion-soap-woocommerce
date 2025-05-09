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

const app = express();
const port = 5000;

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

const soapUrl = process.env.SOAP_URL;

async function procesarProductoIndividual(soapClient, item) {
	const imagenes = [];
	const pdfs = [];

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

	// PDF
	const pdfBuffer = await obtenerPDFBufferDesdeSOAP(item.URL_DOCUMENTOS);
	if (pdfBuffer) {
		console.log(`📄 PDF obtenido (${pdfBuffer.length} bytes)`);
		const pdf = await subirPDFaWordPress(pdfBuffer);
		if (pdf) pdfs.push({ src: pdf });
	}

	// Construcción del objeto de producto WooCommerce
	const productoWoo = construirProductoWoo(item, imagenes, pdfs);

	await retry(
		async () => {
			const responseGet = await wcApi.get("products", { sku: productoWoo.sku });
			const existentes = responseGet.data;

			if (existentes && existentes.length > 0) {
				const existente = mapearProductoWooExistente(existentes[0]);

				if (!_.isEqual(productoWoo, existente)) {
					await wcApi.put(`products/${existentes[0].id}`, productoWoo);
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
	soap.createClient(soapUrl, function (err, soapClient) {
		if (err) {
			return console.error("Error al crear el cliente SOAP:", err);
		}

		console.log("Cliente SOAP creado. Llamando al servicio...");
		console.log(soapClient.describe());
		const args = {};
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

				const cotizacionResult = await new Promise((resolve, reject) => {
					soapClient.servicebus.servicebusSoap12.getWebCotizacion(
						args,
						(err, result) => {
							if (err) return reject(err);
							resolve(result);
						}
					);
				});

				const cotizacionDiffgram =
					cotizacionResult.getWebCotizacionResult.diffgram;
				if (
					!cotizacionDiffgram ||
					!cotizacionDiffgram.NewDataSet ||
					!cotizacionDiffgram.NewDataSet.Table
				) {
					return console.error(
						"No se encontró cotización en la respuesta SOAP."
					);
				}

				const cotizacion = cotizacionDiffgram.NewDataSet.Table.COTIZACION;

				console.log({
					cotizacion,
				});

				let productos = diffgram.NewDataSet.Table;
				if (!Array.isArray(productos)) {
					productos = [productos];
				}

				// Guardar en un archivo JSON todos los productos
				const json = JSON.stringify(productos, null, 2);
				fs.writeFile("productos-all.json", json, (err) => {
					if (err) {
						console.error("Error al escribir el archivo:", err);
					} else {
						console.log("Archivo JSON creado con éxito.");
					}
				});

				// Leer archivo JSON de productos y obtener el total de productos
				const filePath = path.join(__dirname, "productos-all.json");
				fs.readFile(filePath, "utf8", (err, data) => {
					if (err) {
						console.error("Error al leer el archivo:", err);
						return;
					}
					const productos = JSON.parse(data);
					console.log("Total de productos:", productos.length);
				});
			}
		);
	});
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
