require("dotenv").config();

const express = require("express");
const soap = require("soap");
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const cron = require("node-cron");
const WPAPI = require("wpapi");

const app = express();
const port = 5001;

const {
	WC_URL,
	WP_USER,
	WP_PASS,
	WC_CONSUMER_KEY,
	WC_CONSUMER_SECRET,
	SOAP_URL,
} = process.env;

const wp = new WPAPI({
	endpoint: WC_URL,
	username: WP_USER,
	password: WP_PASS,
});

const wcApi = new WooCommerceRestApi({
	url: WC_URL,
	consumerKey: WC_CONSUMER_KEY,
	consumerSecret: WC_CONSUMER_SECRET,
	version: "wc/v3",
});

const ART_CODIGO_BUSCADO = "98197110335802";

async function procesarProductos() {
	try {
		const soapClient = await createSoapClient(SOAP_URL);
		const productos = await obtenerProductosSOAP(soapClient);

		if (!productos || productos.length === 0) {
			console.error("No se encontraron productos en la respuesta SOAP.");
			return;
		}

		console.log("Cantidad de productos:", productos.length);

		const productoEncontrado = productos.find(
			(producto) => producto.ART_CODIGO === ART_CODIGO_BUSCADO
		);

		if (!productoEncontrado) {
			console.error(
				`No se encontró el producto con ART_CODIGO: ${ART_CODIGO_BUSCADO}`
			);
			return;
		}

		console.log("Producto encontrado:", productoEncontrado);
	} catch (error) {
		console.error("Error procesando productos:", error);
	}
}

function createSoapClient(url) {
	return new Promise((resolve, reject) => {
		soap.createClient(url, (err, client) => {
			if (err) return reject("Error al crear el cliente SOAP: " + err);
			resolve(client);
		});
	});
}

function obtenerProductosSOAP(client) {
	return new Promise((resolve, reject) => {
		client.servicebus.servicebusSoap12.getWebProductos({}, (err, result) => {
			if (err) return reject("Error en la llamada SOAP: " + err);

			const productos =
				result?.getWebProductosResult?.diffgram?.NewDataSet?.Table;

			if (!productos) return resolve([]);

			resolve(Array.isArray(productos) ? productos : [productos]);
		});
	});
}

// Descomenta uno de estos si quieres habilitar los cron jobs:
// cron.schedule("*/30 * * * *", () => procesarProductos()); // Cada 30 minutos
// cron.schedule("0 */6 * * *", () => procesarProductos());  // Cada 6 horas

app.get("/integrar", async (req, res) => {
	await procesarProductos();
	res.send("Proceso de integración iniciado.");
});

app.listen(port, () => {
	console.log(`Servidor Express escuchando en http://localhost:${port}`);
});
