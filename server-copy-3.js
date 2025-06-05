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
const {
	obtenerTodasLasCategorias,
	procesarImagenesCategorias,
} = require("./src/services/categorias-service");
const {
	obtenerTodasLasMarcas,
	procesarMarcasWooDesdeSOAP,
} = require("./src/services/marcas-service");

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
const categoriaJerarquiaCache = new Map();

async function asegurarCategoriaJerarquia(
	nombreCategoria,
	nombreCategoria1,
	nombreCategoria2
) {
	const niveles = [nombreCategoria, nombreCategoria1, nombreCategoria2]
		.map((n) => n?.toString().trim().replace(/\s+/g, " ").toUpperCase())
		.filter((n) => n && n !== "NULL");

	logger.info(`✅ Comprobando jerarquía: ${niveles.join(" > ")}`);

	let parentId = 0;
	let rutaActual = [];

	for (let i = 0; i < niveles.length; i++) {
		const nivel = niveles[i];
		rutaActual.push(nivel);

		const claveSimple = nivel;
		const claveRuta = rutaActual.join(" > ");

		// Verifica si ya se está procesando o procesó la ruta
		if (categoriaJerarquiaCache.has(claveRuta)) {
			const id = await categoriaJerarquiaCache.get(claveRuta);
			parentId = id;
			continue;
		}

		// Creamos la promesa y la guardamos inmediatamente para que otros procesos esperen
		const promesaCategoria = (async () => {
			// 1. Consultamos si ya existe con ese nombre bajo el parent
			try {
				const response = await wcApi.get("products/categories", {
					search: nivel,
					parent: parentId,
					per_page: 100,
				});

				const categoriaExistente = response.data.find(
					(cat) => cat.name.toLowerCase() === nivel.toLowerCase()
				);

				if (categoriaExistente) {
					logger.info(
						`📁 Categoría existente encontrada: ${claveRuta} (ID: ${categoriaExistente.id})`
					);
					return categoriaExistente.id;
				}

				// 2. Crear si no existe
				const nueva = await wcApi.post("products/categories", {
					name: nivel,
					parent: parentId !== 0 ? parentId : undefined,
				});
				logger.info(`🆕 Categoría creada: ${claveRuta} (ID: ${nueva.data.id})`);
				return nueva.data.id;
			} catch (error) {
				const errorData = error.response?.data || {};
				logger.error(`❌ Error en categoría "${nivel}": ${error.message}`);
				logger.error(`📄 Detalle: ${JSON.stringify(errorData, null, 2)}`);

				if (errorData.code === "term_exists" && errorData.data?.resource_id) {
					logger.warn(
						`⚠️ Categoría "${nivel}" ya existe. ID: ${errorData.data.resource_id}`
					);
					return errorData.data.resource_id;
				}

				throw error;
			}
		})();

		// Guardamos la promesa en cache para que otros esperen esta creación/consulta
		categoriaJerarquiaCache.set(claveRuta, promesaCategoria);

		const categoriaId = await promesaCategoria;
		parentId = categoriaId;

		// Guardamos también la clave simple
		if (i === 0 && !categoriaJerarquiaCache.has(claveSimple)) {
			categoriaJerarquiaCache.set(claveSimple, Promise.resolve(categoriaId));
		}
	}

	return parentId;
}

async function procesarProductos() {
	const productos = require("./productos-all-07.json");
	if (!Array.isArray(productos)) {
		productos = [productos];
	}

	logger.info(`📦 Productos obtenidos desde SOAP: ${productos.length}`);

	await new Promise((resolve) => setTimeout(resolve, 3000));

	// -----------------------------------------------------------------

	const chunkArray = (array, size) => {
		const result = [];
		for (let i = 0; i < array.length; i += size) {
			result.push(array.slice(i, i + size));
		}
		return result;
	};

	const enviarBatch = async (crear, actualizar) => {
		try {
			const response = await wcApi.post("products/batch", {
				create: crear,
				update: actualizar,
			});

			const info = {
				...(crear.length > 0 && { creados: response.data.create.length }),
				...(actualizar.length > 0 && {
					actualizados: response.data.update.length,
				}),
			};

			logger.info(`Resultado de sync: ${JSON.stringify(info)}`);
		} catch (error) {
			console.error("❌ Error al enviar batch:", error.message || error);
		}
	};

	const cacheCategorias = new Map();
	const limit = pLimit(5);

	const chunks = chunkArray(productos, 50);

	for (const chunk of chunks) {
		const productosParaCrear = [];
		const productosParaActualizar = [];

		await Promise.all(
			chunk.map((item) =>
				limit(async () => {
					try {
						const categoriasName = [
							item.FAMILIA.trim(),
							item.FAMILIA_NIVEL1.trim(),
							item.FAMILIA_NIVEL2.trim(),
						].join(" > ");

						let categoriasIds = [];

						let promesaCategoria = cacheCategorias.get(categoriasName);

						if (!promesaCategoria) {
							promesaCategoria = asegurarCategoriaJerarquia(
								item.FAMILIA?.trim(),
								item.FAMILIA_NIVEL1?.trim(),
								item.FAMILIA_NIVEL2?.trim()
							).then((id) => {
								if (!id) {
									logger.warn(
										`❌ No se pudo asegurar la categoría: ${categoriasName}, usando fallback 7126`
									);
									return 7126;
								}
								logger.info(
									`🆕 Creando categoría: ${categoriasName} (ID: ${id})`
								);
								return id;
							});

							cacheCategorias.set(categoriasName, promesaCategoria);
						} else {
							logger.info(
								`⏳ Esperando creación ya iniciada para categoría: ${categoriasName}`
							);
						}

						const categoriaIdFinal = await promesaCategoria;

						categoriasIds = [{ id: categoriaIdFinal }];

						logger.info(
							`Categoría ID de ${item.ART_CODIGO}: ${JSON.stringify(
								categoriasIds
							)}`
						);

						let existente = await wcApi.get("products", {
							sku: item.ART_CODIGO,
						});
						if (existente && existente.data.length > 0) {
							existente = existente.data[0];
						}

						if (existente) {
							const productoExistenteMapeado =
								mapearProductoWooExistente(existente);

							productoExistenteMapeado.id = existente.id;
							productoExistenteMapeado.categories = categoriasIds;

							logger.info(
								`🔁 Actualizando solo categoría para SKU ${item.ART_CODIGO}`
							);

							// logger.info(JSON.stringify(productoExistenteMapeado, null, 2));

							productosParaActualizar.push(productoExistenteMapeado);
						} else {
							// logger.info(
							// 	`🆕 Producto ${item.ART_CODIGO} SKU: ${productoWoo.sku}, crear`
							// );
							// productosParaCrear.push(productoWoo);

							logger.info("Producto no encontrado, creando nuevo...");
						}
					} catch (error) {
						logger.error(
							`❌ Error procesando SKU ${item.ART_CODIGO}: ${
								error.message || error
							}`
						);
					}
				})
			)
		);

		if (productosParaCrear.length > 0 || productosParaActualizar.length > 0) {
			await enviarBatch(productosParaCrear, productosParaActualizar);

			await new Promise((resolve) => setTimeout(resolve, 3000));
		}
	}

	logger.info("✅ Proceso de sincronización finalizado.");
	// });
}

app.get("/integrar", (req, res) => {
	logger.info("Iniciando proceso de integración...");
	procesarProductos()
		.then(() => {
			res.status(200).send("Proceso de integración completado.");
		})
		.catch((error) => {
			logger.error("Error en el proceso de integración:", error);
			res.status(500).send("Error en el proceso de integración.");
		});
});

app.listen(port, () => {
	console.log(`Servidor Express escuchando en http://localhost:${port}`);
});
