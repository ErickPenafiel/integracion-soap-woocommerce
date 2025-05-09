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

				let imagenesValidas = [];
				let imagenesInvalidas = [];

				for (let item of productos) {
					const imagenes = [];
					const pdfs = [];

					let imagenBase64 = null;

					imagenBase64 = await obtenerImagenDesdeSOAP(
						soapClient,
						item.URL_IMAGEN_PRIMARIA
					);

					if (imagenBase64 && imagenBase64.startsWith("C:")) {
						const newURL = item.URL_IMAGEN_PRIMARIA.replace("WEBP", "JPG");
						// console.log("Imagen inválida: JPG", newURL);

						imagenBase64 = await obtenerImagenDesdeSOAP(soapClient, newURL);
					}

					if (imagenBase64 && imagenBase64.startsWith("C:")) {
						const newURL = item.URL_IMAGEN_PRIMARIA.replace("WEBP", "PNG");
						// console.log("Imagen inválida: PNG", newURL);

						imagenBase64 = await obtenerImagenDesdeSOAP(soapClient, newURL);
					}

					if (imagenBase64 && imagenBase64.startsWith("C:")) {
						console.log("Imagen inválida:", item.ART_CODIGO);

						imagenesInvalidas.push({
							src: imagenBase64,
							sku: item.ART_CODIGO,
						});
					} else {
						console.log("Imagen válida:", item.ART_CODIGO);

						imagenesValidas.push({
							src: imagenBase64,
							sku: item.ART_CODIGO,
						});
					}
				}

				console.log("Imagenes válidas:", imagenesValidas.length);
				console.log("Imagenes inválidas:", imagenesInvalidas.length);
			}
		);
	});
}

async function obtenerImagenDesdeSOAP(soapClient, urlPath) {
	if (!urlPath) return null;

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

app.get("/integrar", (req, res) => {
	procesarProductos();
	res.send("Proceso de integración iniciado.");
});

app.listen(port, () => {
	console.log(`Servidor Express escuchando en http://localhost:${port}`);
});
