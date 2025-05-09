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

const app = express();
const port = 5000;

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

async function asegurarMarca(nombreMarca) {
	try {
		// Buscar la marca por nombre
		const response = await wcApi.get("products/brands", {
			search: nombreMarca,
			per_page: 100,
		});

		const marcaExistente = response.data.find(
			(brand) => brand.name.toLowerCase() === nombreMarca.toLowerCase()
		);

		if (marcaExistente) {
			return marcaExistente.id;
		}

		// Crear la marca si no existe
		const nueva = await wcApi.post("products/brands", {
			name: nombreMarca,
		});
		console.log(`🆕 Marca "${nombreMarca}" creada.`);

		return nueva.data.id;
	} catch (error) {
		console.error(`❌ Error asegurando marca "${nombreMarca}":`, error.message);
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

app.get("/integrar", async (req, res) => {
	// procesarProductos();

	const brandId = await asegurarMarca("Marca de Ejemplo");

	let producto = await wcApi.get("products", {
		sku: 3014248218,
	});

	let response = await wcApi.put(`products/${producto.data[0].id}`, {
		brands: [brandId],
	});

	console.log("Producto actualizado:", response.data);

	// console.log({
	// 	producto,
	// 	marca: brandId,
	// });

	res.send("Integración iniciada. Revisa la consola para más detalles.");
});

app.listen(port, () => {
	console.log(`Servidor Express escuchando en http://localhost:${port}`);
});
