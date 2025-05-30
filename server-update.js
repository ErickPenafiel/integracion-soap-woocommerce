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
	mapearProductoWooExistente,
} = require("./mappers/mappProductoExistente");
const { construirProductoWoo } = require("./helpers/products");

const app = express();
const port = 5000;

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

function redondearUSD(valor) {
	const v = parseFloat(valor);
	if (v < 10) {
		return Math.ceil(v * 10) / 10;
	} else if (v < 100) {
		return Math.ceil(v * 10) / 10;
	} else if (v < 1000) {
		return Math.ceil(v);
	} else {
		const entero = Math.ceil(v);
		const resto = entero % 10;
		return resto === 0 ? entero : entero + (10 - resto);
	}
}

function formatearUSD(valor) {
	const redondeado = redondearUSD(valor);
	let opcionesFormato;

	if (valor < 10) {
		opcionesFormato = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
	} else if (valor < 100) {
		opcionesFormato = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
	} else {
		opcionesFormato = { minimumFractionDigits: 0, maximumFractionDigits: 0 };
	}

	console.log(`USD ${redondeado.toLocaleString("de-DE", opcionesFormato)}`);
	return `${redondeado.toLocaleString("de-DE", opcionesFormato)}`;
}

async function asegurarCategoriaJerarquia(
	nombreCategoria,
	nombreCategoria1,
	nombreCategoria2
) {
	const niveles = [nombreCategoria, nombreCategoria1, nombreCategoria2]
		.map((n) => n?.toString().trim().replace(/\s+/g, " "))
		.filter((n) => n && n.toUpperCase() !== "NULL");

	let parentId = 0;
	let ultimaCategoriaId = null;

	for (const nivel of niveles) {
		try {
			// Buscar categoría en este nivel
			const response = await wcApi.get("products/categories", {
				search: nivel,
				parent: parentId,
				per_page: 100,
			});

			let categoriaExistente = response.data.find(
				(cat) => cat.name.toLowerCase() === nivel.toLowerCase()
			);

			if (categoriaExistente) {
				console.log(
					`🆕 Categoría ${nivel} ya existe con ID ${categoriaExistente.id}.`
				);
				ultimaCategoriaId = categoriaExistente.id;
			} else {
				// Crear categoría nueva en este nivel
				const nueva = await wcApi.post("products/categories", {
					name: nivel,
					parent: parentId !== 0 ? parentId : undefined,
				});
				console.log(`🆕 Categoría ${nivel} creada.`);
				ultimaCategoriaId = nueva.data.id;
			}

			// El siguiente nivel debe tener este como padre
			parentId = ultimaCategoriaId;
		} catch (error) {
			console.error(`❌ Error asegurando categoría "${nivel}":`, error.message);
			return null;
		}
	}

	return ultimaCategoriaId;
}

function chunkArray(array, size) {
	const result = [];
	for (let i = 0; i < array.length; i += size) {
		result.push(array.slice(i, i + size));
	}
	return result;
}

async function crearMarcasBatch(nombresMarcas) {
	const creadas = [];

	const chunks = chunkArray([...nombresMarcas], 10);
	for (const chunk of chunks) {
		const response = await wcApi.post("products/brands/batch", {
			create: chunk.map((name) => ({ name: name.trim() })),
		});
		creadas.push(...response.data.create);
	}
	return new Map(
		creadas
			.filter((m) => m && m.name) // ⚠️ filtra las que no tienen name
			.map((m) => [m.name.trim().toUpperCase(), m.id])
	);
}

async function procesarProductos() {
	const productos = require("./productos-all-02.json");
	console.log("📦 Productos obtenidos desde JSON:", productos.length);

	let cotizacion = 8006;
	console.log("💵 Cotización obtenida desde SOAP:", cotizacion);

	await new Promise((resolve) => setTimeout(resolve, 3000));

	// Marcas Unicas
	const nombresMarcasUnicas = new Set(
		productos
			.map((item) => item.MARCA)
			.filter((nombre) => nombre && nombre !== "NULL")
			.map((nombre) => nombre.trim().toUpperCase())
	);

	console.log("Marcas únicas:", nombresMarcasUnicas.size);
	const mapaMarcas = await crearMarcasBatch(nombresMarcasUnicas);
	console.log("🆕 Marcas creadas en WooCommerce:", mapaMarcas.size);

	// Obtener todas las marcas existentes
	const marcasExistentes = await wcApi.get("products/brands", {
		per_page: 100,
	});

	console.log("Marcas existentes:", marcasExistentes.data.length);

	const marcas = marcasExistentes.data.map((marca) => {
		return {
			id: marca.id,
			name: marca.name.trim().toUpperCase(),
		};
	});
	const marcasMap = new Map(marcas.map((m) => [m.name, m.id]));

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

			console.log({
				...(crear.length > 0 && { creados: response.data.create.length }),
				...(actualizar.length > 0 && {
					actualizados: response.data.update.length,
				}),
			});
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
						const imagenes = [];
						const pdf = null;

						const marcasIds = item.MARCA
							? [marcasMap.get(item.MARCA.trim().toUpperCase())]
							: [];

						const categoriasName = [
							item.FAMILIA.trim(),
							item.FAMILIA_NIVEL1.trim(),
							item.FAMILIA_NIVEL2.trim(),
						].join(" > ");

						let categoriasIds = [];

						if (!cacheCategorias.has(categoriasName)) {
							const categoriaId = await asegurarCategoriaJerarquia(
								item.FAMILIA?.trim(),
								item.FAMILIA_NIVEL1?.trim(),
								item.FAMILIA_NIVEL2?.trim()
							);

							if (categoriaId != null) {
								cacheCategorias.set(
									categoriasName,
									Promise.resolve(categoriaId)
								);
								await new Promise((resolve) => setTimeout(resolve, 1500));
							} else {
								console.warn(
									`⚠️ No se pudo crear/obtener categoría para: ${categoriasName}`
								);
							}
						}

						const categoriaIdFinal = await cacheCategorias.get(categoriasName);

						if (categoriaIdFinal != null) {
							categoriasIds = [
								{
									id: categoriaIdFinal,
								},
							];
						}

						console.log("Categorias Ids", categoriasIds);

						let existente = await wcApi.get("products", {
							sku: item.ART_CODIGO,
						});

						if (existente && existente.data.length > 0) {
							existente = existente.data[0];
						}

						let productoWoo = construirProductoWoo(
							item,
							imagenes,
							pdf,
							categoriasIds,
							cotizacion,
							marcasIds
						);

						if (existente) {
							let productoExistenteMapeado =
								mapearProductoWooExistente(existente);

							if (!_.isEqual(productoWoo, productoExistenteMapeado)) {
								productoWoo.id = existente.id;

								// ✅ Actualizar solo "precio_usd_web" dentro de meta_data
								const nuevoValorUSD = formatearUSD(item.PREC_WEB);

								// Buscar si ya existe el metadato "precio_usd_web"
								const metaExistente = productoExistenteMapeado.meta_data.find(
									(m) => m.key === "precio_usd_web"
								);

								// Reemplazar solo el valor de "precio_usd_web", mantener los demás
								productoWoo.meta_data = productoExistenteMapeado.meta_data.map(
									(m) => {
										if (m.key === "precio_usd_web") {
											return {
												...m,
												value: nuevoValorUSD,
											};
										}
										return m;
									}
								);

								// Si no existía, lo agregamos al final
								if (!metaExistente) {
									productoWoo.meta_data.push({
										key: "precio_usd_web",
										value: nuevoValorUSD,
									});
								}

								console.log(
									`🆕 Producto ${item.ART_CODIGO} SKU: ${productoWoo.sku} - ${productoWoo.id} actualizar`
								);

								productosParaActualizar.push(productoWoo);
							}
						} else {
							console.log(
								`🆕 Producto ${item.ART_CODIGO} SKU: ${productoWoo.sku}, crear`
							);

							productosParaCrear.push(productoWoo);
						}
					} catch (error) {
						console.error(
							`❌ Error procesando SKU ${item.ART_CODIGO}:`,
							error.message
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

	console.log("✅ Proceso de sincronización finalizado.");
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
