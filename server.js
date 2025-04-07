require("dotenv").config();

const express = require("express");
const soap = require("soap");
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const cron = require("node-cron");

const app = express();
const port = 5000;

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

const soapUrl = process.env.SOAP_URL;

const formatImageUrl = (ruta) => {
	if (!ruta || ruta === "NULL") return null;
	console.log(`${process.env.SOAP_URL}/imagenes/${ruta.replace(/\\/g, "/")}`);
	return `${process.env.SOAP_URL}/imagenes/${ruta.replace(/\\/g, "/")}`;
};

async function procesarProductos() {
	soap.createClient(soapUrl, function (err, soapClient) {
		if (err) {
			return console.error("Error al crear el cliente SOAP:", err);
		}

		console.log("Cliente SOAP creado. Llamando al servicio...");
		console.log(soapClient.describe());
		const args = {};

		console.log(soapClient.describe().servicebus.servicebusSoap12.getWebfile);

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

				for (let item of productos) {
					const imagenes = [];
					// const imagenPrimaria = formatImageUrl(item.URL_IMAGEN_PRIMARIA);
					// const imagenSecundaria = formatImageUrl(item.URL_IMAGEN_SECUNDARIA);

					// if (imagenPrimaria) imagenes.push({ src: imagenPrimaria });
					// if (imagenSecundaria) imagenes.push({ src: imagenSecundaria });

					// Obtener la imagen desde SOAP
					// const imagenPrimaria = await obtenerImagenDesdeSOAP(
					// 	soapClient,
					// 	item.URL_IMAGEN_PRIMARIA
					// );
					// const imagenSecundaria = await obtenerImagenDesdeSOAP(
					// 	soapClient,
					// 	item.URL_IMAGEN_SECUNDARIA
					// );

					// console.log("Imagen primaria obtenida desde SOAP:", imagenPrimaria);
					// console.log(
					// 	"Imagen secundaria obtenida desde SOAP:",
					// 	imagenSecundaria
					// );
					// return;

					// if (imagenPrimaria) imagenes.push({ src: imagenPrimaria });
					// if (imagenSecundaria) imagenes.push({ src: imagenSecundaria });

					const productoWoo = {
						name: item.ART_DESCRIPCION || "Producto SOAP sin nombre",
						type: "simple",
						regular_price: item.PREC_WEB || "0",
						sku: item.ART_CODIGO || "",
						description: item.ART_DESCRIPCION || "",
						images: imagenes, // Se añaden imágenes al producto en WooCommerce
						categories: [
							{ name: item.FAMILIA },
							{ name: item.FAMILIA_NIVEL1 },
							{ name: item.FAMILIA_NIVEL2 },
							{ name: item.FAMILIA_NIVEL3 },
							{ name: item.FAMILIA_NIVEL4 },
						],
						tags: item.ETIQUETAS
							? item.ETIQUETAS.split(";").map((tag) => ({ name: tag.trim() }))
							: [],
						attributes: [
							{
								name: "Marca",
								options: [item.MARCA],
							},
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

				// Verificar qué tipo de respuesta devuelve el servicio
				if (result && result.getWebfileResult) {
					resolve(result.getWebfileResult); // Puede ser una URL o base64
				} else {
					resolve(null);
				}
			}
		);
	});
}

cron.schedule("*/5 * * * *", () => {
	console.log("Ejecutando cron job: procesando productos.");
	procesarProductos();
});

app.get("/integrar", (req, res) => {
	procesarProductos();
	res.send("Proceso de integración iniciado.");
});

app.listen(port, () => {
	console.log(`Servidor Express escuchando en http://localhost:${port}`);
});
