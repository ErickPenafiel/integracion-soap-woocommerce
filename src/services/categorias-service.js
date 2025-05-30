const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const path = require("path");
const _ = require("lodash");

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

const { subirImagenDesdeBase64 } = require("./src/services/wp-service");

const { intentarObtenerImagen } = require("./helpers/images");
const logger = require("./src/services/logger");

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

async function procesarImagenesCategorias(soapClient, categorias) {
	const args = {};

	const result = await new Promise((resolve, reject) => {
		soapClient.servicebus.servicebusSoap12.get_familias(args, (err, result) => {
			if (err) return reject(err);
			resolve(result);
		});
	});

	const diffgram = result.get_familiasResult.diffgram;
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
		if (partes.length < 2) continue;

		const categoriaNombre = partes.length === 2 ? partes[0] : partes[1];
		const nombreImagen = partes[partes.length - 1];
		const ext = path.extname(nombreImagen).replace(".", "") || "webp";

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
}

module.exports = {
	obtenerTodasLasCategorias,
	procesarImagenesCategorias,
};
