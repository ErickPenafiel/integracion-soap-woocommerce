const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const path = require("path");
const _ = require("lodash");

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

const { intentarObtenerImagen } = require("../../helpers/images");
const logger = require("./logger");
const { subirImagenDesdeBase64 } = require("./wp-service");

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

		totalPages = parseInt(response.headers["x-wp-totalpages"], 10);
		page++;
	} while (page <= totalPages);

	return categorias;
}

const limpiarNombre = (nombre) =>
	nombre
		?.trim()
		.toUpperCase()
		.replace(/[–—\-;,]/g, " ")
		.replace(/\s+/g, " ");

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
		console.error("No se encontraron productos en la respuesta SOAP.");
		return;
	}

	let categoriasSoap = diffgram.NewDataSet.Table;
	if (!Array.isArray(categoriasSoap)) {
		categoriasSoap = [categoriasSoap];
	}

	logger.info(`🏷️ Marcas obtenidas desde SOAP: ${categoriasSoap.length}`);
	console.log("MarcasSOAP:", categoriasSoap);
	console.log("MarcasWP:", categorias);

	for (const item of categoriasSoap) {
		const rutas = [];

		const limpiarRuta = (ruta) => ruta?.replace(/\s+/g, " ").toUpperCase();

		const partesF2 =
			limpiarRuta(item.FAMILIA2)?.split("\\").filter(Boolean) || [];
		const partesF1 =
			limpiarRuta(item.FAMILIA1)?.split("\\").filter(Boolean) || [];

		if (partesF2.length >= 3) rutas.push(partesF2);
		if (partesF1.length >= 2) rutas.push(partesF1);

		for (const partes of rutas) {
			let categoria = null;
			const nombreImagen = partes[partes.length - 1];
			const ext = path.extname(nombreImagen).replace(".", "") || "webp";

			if (partes.length >= 3) {
				// Ruta con padre e hijo
				const nombrePadre = limpiarNombre(partes[0]);
				const nombreHija = limpiarNombre(partes[1]);

				categoria = categorias.find(
					(c) =>
						limpiarNombre(c.name) === nombreHija &&
						(() => {
							const padre = categorias.find((p) => p.id === c.parent);
							return padre && limpiarNombre(padre.name) === nombrePadre;
						})()
				);

				if (!categoria) {
					logger.warn(
						`❌ No se encontró la subcategoría "${nombreHija}" con padre "${nombrePadre}"`
					);
					continue;
				}
			} else if (partes.length === 2) {
				// Ruta de una sola categoría
				const nombreCategoria = limpiarNombre(partes[0]);

				categoria = categorias.find(
					(c) => limpiarNombre(c.name) === nombreCategoria
				);

				if (!categoria) {
					logger.warn(`❌ No se encontró la categoría "${nombreCategoria}"`);
					continue;
				}
			} else {
				continue; // Ruta inválida
			}

			console.log("Categoria encontrada:", categoria);
			const rutaCompleta = "\\" + partes.join("\\");

			await subirImagenParaCategoria(soapClient, categoria, rutaCompleta, ext);
		}
	}

	logger.info("✅ Proceso de categorías completado.");
}

async function subirImagenParaCategoria(soapClient, categoria, rutaRaw, ext) {
	try {
		logger.info(
			`🕵️ Procesando imagen para categoría "${categoria.name}" desde ruta: ${rutaRaw}`
		);

		const imagenBase64 = await intentarObtenerImagen(soapClient, rutaRaw, ext);

		if (imagenBase64 && !imagenBase64.startsWith("C:")) {
			const imageUrl = await subirImagenDesdeBase64(imagenBase64);

			if (imageUrl) {
				logger.info(
					`📤 Imagen subida para categoría "${categoria.name}" → ${imageUrl}`
				);

				await wcApi.put(`products/categories/${categoria.id}`, {
					image: { src: imageUrl },
				});

				logger.info(`✅ Imagen actualizada para categoría: ${categoria.name}`);
			}
		}
	} catch (err) {
		logger.error(
			`❌ Error procesando imagen para categoría "${categoria.name}": ${err.message}`
		);
	}
}

module.exports = {
	obtenerTodasLasCategorias,
	procesarImagenesCategorias,
};
