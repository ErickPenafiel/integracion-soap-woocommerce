require("dotenv").config();

const express = require("express");
const soap = require("soap");
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const _ = require("lodash");

const app = express();
const port = 5000;

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
				let productos = diffgram.NewDataSet.Table;
				if (!Array.isArray(productos)) {
					productos = [productos];
				}

				const marca = new Set(productos.map((p) => p.MARCA));
				const familia = new Set(productos.map((p) => p.FAMILIA));
				const nivel1 = new Set(productos.map((p) => p.FAMILIA_NIVEL1));
				const nivel2 = new Set(productos.map((p) => p.FAMILIA_NIVEL2));

				// Unir los tres conjuntos en uno solo con valores únicos
				const unionTotal = new Set([...familia, ...nivel1, ...nivel2]);

				console.log(
					"Conjunto unido con valores únicos de FAMILIA, FAMILIA_NIVEL1 y FAMILIA_NIVEL2:"
				);
				console.log([...unionTotal]);

				// Genera un json
				// const json = JSON.stringify(
				// 	{
				// 		familia: [...familia],
				// 		nivel1: [...nivel1],
				// 		nivel2: [...nivel2],
				// 		unionTotal: [...unionTotal],
				// 	},
				// 	null,
				// 	2
				// );
				// const fs = require("fs");
				// fs.writeFile("familia.json", json, (err) => {
				// 	if (err) {
				// 		console.error("Error al escribir el archivo:", err);
				// 	} else {
				// 		console.log("Archivo JSON creado con éxito.");
				// 	}
				// });

				console.log("Total únicos:", {
					total: unionTotal.size,
					familia: familia.size,
					nivel1: nivel1.size,
					nivel2: nivel2.size,
				});

				console.log("Marcas", marca);
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
