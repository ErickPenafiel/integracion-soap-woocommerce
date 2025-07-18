const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const path = require("path");
const { intentarObtenerImagen } = require("../../helpers/images");
const { subirImagenDesdeBase64 } = require("./wp-service");
const logger = require("./logger");

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

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

const limpiarNombre = (nombre) =>
	nombre
		?.trim()
		.toUpperCase()
		.replace(/[–—\-;,]/g, " ")
		.replace(/\s+/g, " ");

async function procesarMarcasWooDesdeSOAP(soapClient, marcas) {
	const args = {};

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
		return console.error("No se encontraron marcas en la respuesta SOAP.");
	}

	let marcasSoap = diffgram.NewDataSet.Table1;
	if (!Array.isArray(marcasSoap)) {
		marcasSoap = [marcasSoap];
	}

	logger.info(`🏷️ Marcas obtenidas desde SOAP: ${marcasSoap.length}`);

	for (const marcaWp of marcas) {
		const marcaSoap = marcasSoap.find(
			(m) => limpiarNombre(m.nombre) === limpiarNombre(marcaWp.name)
		);

		if (!marcaSoap) {
			logger.warn(`⚠️ Marca no encontrada en SOAP: ${marcaWp.name}`);
			continue;
		}

		logger.info(`🔍 Procesando marca: ${marcaWp.name}`);

		if (marcaSoap.logo_path) {
			try {
				const ext =
					path.extname(marcaSoap.logo_path).replace(".", "") || "webp";

				const imagenBase64 = await intentarObtenerImagen(
					soapClient,
					marcaSoap.logo_path,
					ext
				);

				if (imagenBase64 && !imagenBase64.startsWith("C:")) {
					const imageUrl = await subirImagenDesdeBase64(
						imagenBase64,
						true,
						false
					);

					if (imageUrl) {
						logger.info(
							`📤 Imagen subida para marca "${marcaWp.name}" → ${imageUrl}`
						);

						const response = await wcApi.put(`products/brands/${marcaWp.id}`, {
							image: { src: imageUrl },
						});

						console.log({
							response: response.data,
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
}

module.exports = {
	obtenerTodasLasMarcas,
	procesarMarcasWooDesdeSOAP,
};
