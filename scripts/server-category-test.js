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
} = require("../mappers/mappProductoExistente");
const { construirProductoWoo } = require("../helpers/products");

const app = express();
const port = 5000;

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

const categoriaCache = new Map(); // Cache en memoria

async function asegurarCategoriaJerarquia(
	nombreCategoria,
	nombreCategoria1,
	nombreCategoria2
) {
	const niveles = [nombreCategoria, nombreCategoria1, nombreCategoria2]
		.map((n) => n?.toString().trim().replace(/\s+/g, " ")) // asegurarse que sea string y quitar espacios
		.filter((n) => n && n.toUpperCase() !== "NULL"); // descarta null, "", "NULL"

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

async function prepararYCargarCategorias(productos) {
	const combinacionesUnicas = new Set();

	for (const p of productos) {
		const familia = clean(p.FAMILIA);
		const nivel1 = clean(p.FAMILIA_NIVEL1);
		const nivel2 = clean(p.FAMILIA_NIVEL2);

		const key = getKey(familia, nivel1, nivel2);
		if (key) combinacionesUnicas.add(key);
	}

	for (const combinacion of combinacionesUnicas) {
		const [f, n1, n2] = combinacion.split("|");
		const categoriaId = await asegurarCategoriaJerarquia(f, n1, n2);

		if (categoriaId) {
			categoriaCache.set(combinacion, categoriaId);
		}
	}
}

function clean(value) {
	if (!value || value === "NULL" || value === "null") return "";
	return value.trim();
}

function getKey(familia, nivel1, nivel2) {
	const f = familia;
	const n1 = nivel1;
	const n2 = nivel2;

	// Ignorar combinaciones sin ningún valor válido
	if (!f && !n1 && !n2) return null;

	return `${f}|${n1}|${n2}`;
}

function addToMap(familia, nivel1, nivel2) {
	const key = getKey(familia, nivel1, nivel2);
	if (!key) return;
	resultados.set(key, (resultados.get(key) || 0) + 1);
}

function printResultados() {
	console.log("familia,familia_nivel1,familia_nivel2,cantidad_productos");
	for (const [key, count] of resultados.entries()) {
		if (!key) continue;
		const [familia, nivel1, nivel2] = key.split("|");
		console.log(`${familia},${nivel1},${nivel2},${count}`);
	}
}

const resultados = new Map();

async function procesarProductos() {
	const productos = require("../productos-all-05.json");
	console.log("📦 Productos obtenidos desde JSON:", productos.length);

	let cotizacion = 8006;
	console.log("💵 Cotización obtenida desde SOAP:", cotizacion);

	await new Promise((resolve) => setTimeout(resolve, 3000));

	// Marcas Unicas
	await prepararYCargarCategorias(productos);

	console.log("🆕 Categorías cargadas en caché:", categoriaCache.size);
	console.log("Categorías en caché:", categoriaCache);

	// Exporta a un json para ver el resultado
	const categoriasExportadas = Array.from(categoriaCache.entries()).map(
		([key, id]) => {
			const [familia, nivel1, nivel2] = key.split("|");
			return { familia, nivel1, nivel2, id };
		}
	);
	fs.writeFileSync(
		path.join(__dirname, "categorias-exportadas.json"),
		JSON.stringify(categoriasExportadas, null, 2)
	);

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
