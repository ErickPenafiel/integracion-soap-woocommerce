const logger = require("../src/services/logger");
const { redondearGuaranies } = require("./products");
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const retry = require("async-retry");

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

function chunkArray(array, size) {
	const result = [];
	for (let i = 0; i < array.length; i += size) {
		result.push(array.slice(i, i + size));
	}
	return result;
}

function calcularPorcentajeDescuento(regular, oferta) {
	if (!regular || !oferta || oferta >= regular) return 0;
	return 1 - oferta / regular;
}

async function actualizarPreciosDesdeMetaData(
	cotizacion,
	productosProcesadosArray = []
) {
	if (!cotizacion || isNaN(cotizacion)) {
		throw new Error("Cotización no válida.");
	}

	const productosProcesados = new Set(productosProcesadosArray);
	logger.info(`🔄 Actualizando precios con cotización ${cotizacion}...`);

	let pagina = 1;
	let productosActualizados = [];
	let productosOmitidos = 0;
	let productosEvaluados = 0;

	while (true) {
		const response = await wcApi.get("products", {
			per_page: 100,
			page: pagina,
		});

		const productos = response.data;
		if (productos.length === 0) break;

		for (const producto of productos) {
			productosEvaluados++;

			if (productosProcesados.has(producto.sku)) {
				productosOmitidos++;
				logger.info(`⏭ Producto ${producto.sku} ya fue procesado, se omite.`);
				continue;
			}

			const meta = producto.meta_data || [];
			const metaPrecioUSD = meta.find((m) => m.key === "precio_usd_web");

			if (!metaPrecioUSD) {
				logger.warn(
					`❌ Producto ${producto.sku} no tiene metadata 'precio_usd_web'.`
				);
				continue;
			}

			const rawUSD = metaPrecioUSD.value.replace(/\./g, "").replace(",", ".");
			const precioUSD = parseFloat(rawUSD);

			if (isNaN(precioUSD) || precioUSD <= 0) {
				logger.warn(
					`❌ Producto ${producto.id} tiene precio_usd_web inválido: ${metaPrecioUSD.value}`
				);
				continue;
			}

			const nuevoRegularGs = redondearGuaranies(precioUSD * cotizacion);

			const tieneOferta =
				parseFloat(producto.sale_price) > 0 &&
				parseFloat(producto.sale_price) < parseFloat(producto.regular_price);

			const descuentoPorcentaje = tieneOferta
				? calcularPorcentajeDescuento(
						parseFloat(producto.regular_price),
						parseFloat(producto.sale_price)
				  )
				: 0;

			const nuevo = {
				id: producto.id,
				regular_price: nuevoRegularGs.toString(),
			};

			if (descuentoPorcentaje > 0) {
				const nuevoSaleGs = redondearGuaranies(
					nuevoRegularGs * (1 - descuentoPorcentaje)
				);
				nuevo.sale_price = nuevoSaleGs.toString();

				logger.info(
					`🛒 SKU ${producto.sku || producto.id}: aplicando descuento ${(
						descuentoPorcentaje * 100
					).toFixed(2)}% → Gs ${nuevoSaleGs}`
				);
			}

			productosActualizados.push(nuevo);
		}

		pagina++;
	}

	if (productosActualizados.length > 0) {
		const chunks = chunkArray(productosActualizados, 10);

		for (const chunk of chunks) {
			try {
				const resp = await retry(
					async () => {
						const response = await wcApi.post("products/batch", {
							update: chunk,
						});

						logger.info(`🔄 Enviando batch de ${chunk.length} productos...`);

						if (response.status >= 400) {
							throw new Error(`HTTP ${response.status}`);
						}

						return response;
					},
					{
						retries: 3,
						minTimeout: 1000,
						factor: 2,
						onRetry: (err, attempt) => {
							logger.warn(
								`🔁 Reintentando batch (intento ${attempt}): ${err.message}`
							);
						},
					}
				);

				logger.info(`✅ Precios actualizados: ${resp.data.update.length}`);
			} catch (e) {
				logger.error("❌ Fallo definitivo al actualizar precios:", e.message);
			}
		}
	} else {
		logger.info(
			"📭 No se encontraron productos con metadata 'precio_usd_web' o ya fueron procesados."
		);
	}

	// 🔚 Resumen final
	logger.info(`📊 Resumen final:
  • Evaluados: ${productosEvaluados}
  • Omitidos (ya procesados): ${productosOmitidos}
  • Actualizados: ${productosActualizados.length}`);
}

async function actualizarPreciosDesdeMetaData(
	cotizacion,
	productosProcesadosArray = []
) {
	if (!cotizacion || isNaN(cotizacion)) {
		throw new Error("Cotización no válida.");
	}

	const productosProcesados = new Set(productosProcesadosArray);
	logger.info(`🔄 Actualizando precios con cotización ${cotizacion}...`);

	let pagina = 1;
	let productosActualizados = [];
	let productosOmitidos = 0;
	let productosEvaluados = 0;

	while (true) {
		const response = await wcApi.get("products", {
			per_page: 100,
			page: pagina,
		});

		const productos = response.data;
		if (productos.length === 0) break;

		for (const producto of productos) {
			productosEvaluados++;

			if (productosProcesados.has(producto.sku)) {
				productosOmitidos++;
				logger.info(`⏭ Producto ${producto.sku} ya fue procesado, se omite.`);
				continue;
			}

			const meta = producto.meta_data || [];
			const metaPrecioUSD = meta.find((m) => m.key === "precio_usd_web");

			if (!metaPrecioUSD) {
				logger.warn(
					`❌ Producto ${producto.sku} no tiene metadata 'precio_usd_web'.`
				);
				continue;
			}

			const rawUSD = metaPrecioUSD.value.replace(/\./g, "").replace(",", ".");
			const precioUSD = parseFloat(rawUSD);

			if (isNaN(precioUSD) || precioUSD <= 0) {
				logger.warn(
					`❌ Producto ${producto.id} tiene precio_usd_web inválido: ${metaPrecioUSD.value}`
				);
				continue;
			}

			const nuevoRegularGs = redondearGuaranies(precioUSD * cotizacion);

			const tieneOferta =
				parseFloat(producto.sale_price) > 0 &&
				parseFloat(producto.sale_price) < parseFloat(producto.regular_price);

			const descuentoPorcentaje = tieneOferta
				? calcularPorcentajeDescuento(
						parseFloat(producto.regular_price),
						parseFloat(producto.sale_price)
				  )
				: 0;

			const nuevo = {
				id: producto.id,
				regular_price: nuevoRegularGs.toString(),
			};

			if (descuentoPorcentaje > 0) {
				const nuevoSaleGs = redondearGuaranies(
					nuevoRegularGs * (1 - descuentoPorcentaje)
				);
				nuevo.sale_price = nuevoSaleGs.toString();

				logger.info(
					`🛒 SKU ${producto.sku || producto.id}: aplicando descuento ${(
						descuentoPorcentaje * 100
					).toFixed(2)}% → Gs ${nuevoSaleGs}`
				);
			}

			productosActualizados.push(nuevo);
		}

		pagina++;
	}

	if (productosActualizados.length > 0) {
		const chunks = chunkArray(productosActualizados, 10);

		for (const chunk of chunks) {
			try {
				const resp = await retry(
					async () => {
						const response = await wcApi.post("products/batch", {
							update: chunk,
						});

						if (response.status >= 400) {
							throw new Error(`HTTP ${response.status}`);
						}

						return response;
					},
					{
						retries: 3,
						minTimeout: 1000,
						factor: 2,
						onRetry: (err, attempt) => {
							logger.warn(
								`🔁 Reintentando batch (intento ${attempt}): ${err.message}`
							);
						},
					}
				);

				logger.info(`✅ Precios actualizados: ${resp.data.update.length}`);
			} catch (e) {
				logger.error("❌ Fallo definitivo al actualizar precios:", e.message);
			}
		}
	} else {
		logger.info(
			"📭 No se encontraron productos con metadata 'precio_usd_web' o ya fueron procesados."
		);
	}

	// 🔚 Resumen final
	logger.info(`📊 Resumen final:
  • Evaluados: ${productosEvaluados}
  • Omitidos (ya procesados): ${productosOmitidos}
  • Actualizados: ${productosActualizados.length}`);
}

module.exports = {
	actualizarPreciosDesdeMetaData,
	calcularPorcentajeDescuento,
	// probarActualizacionPorSku,
};
