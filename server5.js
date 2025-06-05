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
const { type } = require("os");
const logger = require("./src/services/logger");

const app = express();
const port = 5000;

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

const soapUrl = process.env.SOAP_URL;

const cacheBuffersPDF = new Map();

async function obtenerTodasLasCategorias() {
	let categorias = [];
	let page = 1;
	let totalPages;

	do {
		const response = await wcApi.get("products/categories", {
			per_page: 100,
			page: page,
		});

		const newCategorias = response.data.map((categoria) => {
			return {
				id: categoria.id,
				name: categoria.name,
				slug: categoria.slug,
				parent: categoria.parent,
				image: categoria.image ? categoria.image.src : null,
			};
		});

		categorias.push(...newCategorias);

		// WooCommerce pone el total de páginas en headers
		totalPages = parseInt(response.headers["x-wp-totalpages"], 10);
		page++;
	} while (page <= totalPages);

	return categorias;
}

async function obtenerTodasLasMarcas() {
	let marcas = [];
	let page = 1;
	let totalPages;

	do {
		const response = await wcApi.get("products/brands", {
			per_page: 100,
			page: page,
		});

		const newMarcas = response.data.map((marca) => {
			return {
				id: marca.id,
				name: marca.name,
				slug: marca.slug,
				parent: marca.parent,
				image: marca.image ? marca.image.src : null,
			};
		});

		marcas.push(...newMarcas);

		totalPages = parseInt(response.headers["x-wp-totalpages"], 10);
		page++;
	} while (page <= totalPages);

	return marcas;
}

async function procesarProductos() {
	soap.createClient(soapUrl, async function (err, soapClient) {
		if (err) {
			return console.error("Error al crear el cliente SOAP:", err);
		}

		const args = {};
		const categorias = await obtenerTodasLasCategorias();

		const result = await new Promise((resolve, reject) => {
			soapClient.servicebus.servicebusSoap12.get_familias(
				args,
				(err, result) => {
					if (err) return reject(err);
					resolve(result);
				}
			);
		});

		// console.log("Result", result);

		const diffgram = result.get_familiasResult.diffgram;
		console.log(diffgram);
		if (!diffgram || !diffgram.NewDataSet || !diffgram.NewDataSet.Table) {
			return console.error("No se encontraron productos en la respuesta SOAP.");
		}

		let categoriasSoap = diffgram.NewDataSet.Table;
		if (!Array.isArray(categoriasSoap)) {
			categoriasSoap = [categoriasSoap];
		}

		logger.info(`🏷️ Marcas obtenidas desde SOAP: ${categoriasSoap.length}`);
		console.log("MarcasSOAP: ", categoriasSoap);
		console.log("MarcasWP: ", categorias);

		for (const item of categoriasSoap) {
			const rutaRaw = item.FAMILIA1 || item.FAMILIA2;
			if (!rutaRaw || !rutaRaw.includes("\\")) continue;

			const partes = rutaRaw.split("\\").filter(Boolean);

			if (partes.length < 2) continue; // aseguramos que al menos haya nombre e imagen

			const categoriaNombre = partes.length === 2 ? partes[0] : partes[1]; // puede ser solo BOMBA o BOMBA > KIT BOMBA
			const nombreImagen = partes[partes.length - 1];
			const ext = path.extname(nombreImagen).replace(".", "") || "webp";

			// Buscar categoría en WooCommerce
			const categoria = categorias.find(
				(c) =>
					c.name.trim().toUpperCase() === categoriaNombre.trim().toUpperCase()
			);

			if (!categoria) {
				logger.warn(`❌ Categoría no encontrada: ${categoriaNombre}`);
				continue;
			}

			try {
				const imagenBase64 = await intentarObtenerImagen(
					soapClient,
					rutaRaw,
					ext
				);

				if (imagenBase64 && !imagenBase64.startsWith("C:")) {
					const imageUrl = await subirImagenDesdeBase64(imagenBase64);

					if (imageUrl) {
						logger.info(
							`📤 Imagen subida para categoría "${categoria.name}" → ${imageUrl}`
						);

						// Actualizar imagen en WooCommerce
						await wcApi.put(`products/categories/${categoria.id}`, {
							image: { src: imageUrl },
						});

						logger.info(
							`✅ Imagen actualizada para categoría: ${categoria.name}`
						);
					}
				}
			} catch (err) {
				logger.error(
					`❌ Error procesando imagen para categoría ${categoriaNombre}: ${err.message}`
				);
			}
		}

		logger.info("✅ Proceso de categorias completado.");
	});
}

// cron.schedule("*/30 * * * *", () => {
// 	console.log("Ejecutando cron job: procesando productos.");
// 	procesarProductos();
// });

app.get("/integrar", (req, res) => {
	procesarProductos();
	res.send("Proceso de integración iniciado.");
});

app.listen(port, () => {
	console.log(`Servidor Express escuchando en http://localhost:${port}`);
});
