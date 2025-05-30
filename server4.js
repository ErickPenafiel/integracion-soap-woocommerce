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

		categorias.push(...response.data);

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
		const marcas = await obtenerTodasLasMarcas();

		const result = await new Promise((resolve, reject) => {
			soapClient.servicebus.servicebusSoap12.LoadFilesAndFolders(
				args,
				(err, result) => {
					if (err) return reject(err);
					resolve(result);
				}
			);
		});

		const diffgram = result.LoadFilesAndFoldersResult.diffgram;
		if (!diffgram || !diffgram.NewDataSet || !diffgram.NewDataSet.Table1) {
			return console.error("No se encontraron productos en la respuesta SOAP.");
		}

		let marcasSoap = diffgram.NewDataSet.Table1;
		if (!Array.isArray(marcasSoap)) {
			marcasSoap = [marcasSoap];
		}

		logger.info(`🏷️ Marcas obtenidas desde SOAP: ${marcasSoap.length}`);

		for (const marcaWp of marcas) {
			const marcaSoap = marcasSoap.find(
				(m) =>
					m.nombre?.trim().toUpperCase() === marcaWp.name.trim().toUpperCase()
			);

			if (!marcaSoap) {
				logger.warn(`⚠️ Marca no encontrada en SOAP: ${marcaWp.name}`);
				continue;
			}
			logger.info(`🔍 Procesando marca: ${marcaWp.name}`);

			if (marcaSoap && marcaSoap.logo_path) {
				try {
					const ext = marcaSoap.logo_path.split(".").pop();
					const imagenBase64 = await intentarObtenerImagen(
						soapClient,
						marcaSoap.logo_path,
						ext
					);

					if (imagenBase64 && !imagenBase64.startsWith("C:")) {
						const imageUrl = await subirImagenDesdeBase64(imagenBase64);

						if (imageUrl) {
							logger.info(
								`📤 Imagen subida para marca "${marcaWp.name}" → ${imageUrl}`
							);

							// Actualizar la imagen de la marca en WooCommerce
							await wcApi.put(`products/brands/${marcaWp.id}`, {
								image: {
									src: imageUrl,
								},
							});
							logger.info(`✅ Marca actualizada: ${marcaWp.name}`);
						}
					}
				} catch (err) {
					logger.error(
						`❌ Error procesando imagen para marca ${marcaWp.name}: ${err.message}`
					);
				}
			}
		}

		logger.info("✅ Proceso de marcas completado.");
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
