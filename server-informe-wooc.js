// require("dotenv").config();
// const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
// const fs = require("fs");
// const path = require("path");

// const wcApi = new WooCommerceRestApi({
// 	url: process.env.WC_URL,
// 	consumerKey: process.env.WC_CONSUMER_KEY,
// 	consumerSecret: process.env.WC_CONSUMER_SECRET,
// 	version: "wc/v3",
// 	axiosConfig: {
// 		timeout: 30000,
// 	},
// });

// async function obtenerTodosLosProductos() {
// 	let page = 1;
// 	const perPage = 100;
// 	let productos = [];

// 	while (true) {
// 		const { data, headers } = await wcApi.get("products", {
// 			per_page: perPage,
// 			page: page,
// 			status: "any", // 👈 esto permite traer productos en cualquier estado
// 		});

// 		console.log(`🔄 Página ${page}: ${data.length} productos`);
// 		if (data.length === 0) break;

// 		productos.push(...data);
// 		page++;
// 	}

// 	console.log(`✅ Total productos recibidos: ${productos.length}`);
// 	return productos;
// }

// function verificarCampoMeta(metaData, key) {
// 	const campo = metaData.find((m) => m.key === key);
// 	return {
// 		valor: campo?.value || null,
// 		existe: !!campo?.value,
// 	};
// }

// async function procesarProductosWoo() {
// 	try {
// 		const productos = await obtenerTodosLosProductos();

// 		const resultados = productos.map((producto) => {
// 			const sku = producto.sku;
// 			const cantidadImagenes = (producto.images || []).length;
// 			const meta = producto.meta_data || [];

// 			const manual = verificarCampoMeta(meta, "manual");
// 			const fichaTecnica = verificarCampoMeta(meta, "fichatecnica");
// 			const dimensional = verificarCampoMeta(meta, "dimensional");

// 			return {
// 				sku,
// 				cantidadImagenes,
// 				manual,
// 				fichatecnica: fichaTecnica,
// 				dimensional,
// 			};
// 		});

// 		// Exportar a archivo JSON
// 		const nombreArchivo = "productos_wc_info.json";
// 		const filePath = path.join(__dirname, nombreArchivo);
// 		fs.writeFileSync(filePath, JSON.stringify(resultados, null, 2));
// 		console.log(`✅ Productos exportados a ${nombreArchivo.length}`);

// 		const productosResult = require("./productos_wc_info.json");
// 		console.log(`Total productos procesados: ${productosResult.length}`);

// 		console.log(`✅ Productos exportados a ${nombreArchivo}`);
// 	} catch (err) {
// 		console.error("❌ Error al procesar productos:", err.message || err);
// 	}
// }

// // Ejecutar
// procesarProductosWoo();

require("dotenv").config();
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
	axiosConfig: {
		timeout: 30000,
	},
});

async function obtenerTodosLosProductos() {
	let page = 1;
	const perPage = 100;
	let productos = [];

	while (true) {
		const { data } = await wcApi.get("products", {
			per_page: perPage,
			page: page,
			status: "any",
		});

		console.log(`🔄 Página ${page}: ${data.length} productos`);
		if (data.length === 0) break;

		productos.push(...data);
		page++;
	}

	console.log(`✅ Total productos recibidos: ${productos.length}`);
	return productos;
}

function verificarCampoMeta(metaData, key) {
	const campo = metaData.find((m) => m.key === key);
	return {
		valor: campo?.value || null,
		existe: !!campo?.value,
	};
}

async function procesarProductosWoo() {
	try {
		const productos = await obtenerTodosLosProductos();

		const sinImagenes = productos
			.filter((p) => (p.images || []).length === 0)
			.map((producto) => {
				const sku = producto.sku;
				const meta = producto.meta_data || [];

				const manual = verificarCampoMeta(meta, "manual");
				const fichaTecnica = verificarCampoMeta(meta, "fichatecnica");
				const dimensional = verificarCampoMeta(meta, "dimensional");

				return {
					SKU: sku,
					Nombre: producto.name,
					Manual: manual.existe ? "✅" : "❌",
					"Ficha Técnica": fichaTecnica.existe ? "✅" : "❌",
					Dimensional: dimensional.existe ? "✅" : "❌",
				};
			});

		if (sinImagenes.length === 0) {
			console.log("✅ Todos los productos tienen imágenes.");
			return;
		}

		// Crear Excel
		const worksheet = XLSX.utils.json_to_sheet(sinImagenes);
		const workbook = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(workbook, worksheet, "Sin Imágenes");

		// Fecha de hoy y hora
		const fecha = new Date();
		const opcionesFecha = {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		};

		const fechaFormateada = fecha
			.toLocaleDateString("es-ES", opcionesFecha)
			.replace(/\//g, "-")
			.replace(/,/g, "")
			.replace(/:/g, "-");

		const nombreArchivo = `productos_sin_imagenes_${fechaFormateada}.xlsx`;
		const filePath = path.join(__dirname, nombreArchivo);
		XLSX.writeFile(workbook, filePath);

		console.log(`📦 Archivo Excel generado: ${nombreArchivo}`);
		console.log(`🧾 Total sin imágenes: ${sinImagenes.length}`);
	} catch (err) {
		console.error("❌ Error al procesar productos:", err.message || err);
	}
}

procesarProductosWoo();
