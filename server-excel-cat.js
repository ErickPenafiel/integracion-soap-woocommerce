require("dotenv").config();

const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

async function obtenerCategoriasDesdeWooCommerce() {
	const todas = [];
	let pagina = 1;
	let hayMas = true;

	while (hayMas) {
		const res = await wcApi.get("products/categories", {
			per_page: 100,
			page: pagina,
		});

		todas.push(...res.data);
		hayMas = res.data.length === 100;
		pagina++;
	}

	return todas;
}

function construirJerarquiaCategorias(categorias) {
	const mapa = new Map();
	categorias.forEach((cat) => mapa.set(cat.id, { ...cat, hijos: [] }));

	const raiz = [];

	for (const cat of categorias) {
		if (cat.parent === 0) {
			raiz.push(mapa.get(cat.id));
		} else if (mapa.has(cat.parent)) {
			mapa.get(cat.parent).hijos.push(mapa.get(cat.id));
		}
	}

	return raiz;
}

function convertirJerarquiaATabla(
	categorias,
	nivel = 0,
	fila = [],
	resultado = []
) {
	for (const cat of categorias) {
		const nuevaFila = [...fila];
		nuevaFila[nivel] = cat.name;
		// Añadimos la cantidad al final de la fila
		const filaConCantidad = [...nuevaFila.slice(0, 3), cat.count || 0];

		if (cat.hijos.length > 0) {
			convertirJerarquiaATabla(cat.hijos, nivel + 1, nuevaFila, resultado);
		} else {
			resultado.push(filaConCantidad);
		}
	}
	return resultado;
}

function generarExcelConXLSX(tabla) {
	const encabezado = [
		"familia",
		"familia nivel 1",
		"familia nivel 2",
		"cantidad productos",
	];
	const data = [
		encabezado,
		...tabla.map((row) => [
			row[0] || "",
			row[1] || "",
			row[2] || "",
			row[3] || 0,
		]),
	];

	const worksheet = XLSX.utils.aoa_to_sheet(data);
	const workbook = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(workbook, worksheet, "Categorias");

	const filePath = path.join(__dirname, "categorias.xlsx");
	XLSX.writeFile(workbook, filePath);
	console.log("✅ Excel generado en:", filePath);
}

async function exportarCategoriasAExcel() {
	try {
		const categorias = await obtenerCategoriasDesdeWooCommerce();
		const jerarquia = construirJerarquiaCategorias(categorias);
		const tabla = convertirJerarquiaATabla(jerarquia);
		generarExcelConXLSX(tabla);
	} catch (err) {
		console.error("❌ Error exportando categorías:", err.message);
	}
}

exportarCategoriasAExcel();
