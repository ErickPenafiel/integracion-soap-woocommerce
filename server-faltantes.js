// const fs = require("fs");
// const path = require("path");

// function normalize(value) {
// 	return String(value).trim().replace(/^0+/, "");
// }

// const jsonWoo = JSON.parse(
// 	fs.readFileSync(path.join(__dirname, "productos_wc_info.json"))
// );
// const jsonSoap = JSON.parse(
// 	fs.readFileSync(path.join(__dirname, "productos-all-11.json"))
// );

// // Filtrar productos con SKU válido
// const skusWooValidos = jsonWoo
// 	.map((item) => item.sku)
// 	.filter((sku) => sku && sku.trim() !== "")
// 	.map((sku) => normalize(sku));

// const skusWooSet = new Set(skusWooValidos);

// // Detectar faltantes
// const productosFaltantes = jsonSoap.filter((item) => {
// 	const artCodigo = normalize(item.ART_CODIGO);
// 	const estaEnWoo = skusWooSet.has(artCodigo);
// 	if (!estaEnWoo) {
// 		console.log(`❌ SKU faltante: ${artCodigo} - ${item.ART_DESCRIPCION}`);
// 	}
// 	return !estaEnWoo;
// });

// // Exportar
// const outputPath = path.join(__dirname, "productos_faltantes.json");
// fs.writeFileSync(outputPath, JSON.stringify(productosFaltantes, null, 2));

// console.log("🔎 Total WooCommerce (con SKU válido):", skusWooValidos.length);
// console.log("🔎 Total SOAP:", jsonSoap.length);
// console.log(`✅ Faltantes detectados: ${productosFaltantes.length}`);
// console.log(`📄 Guardado en: productos_faltantes.json`);

const fs = require("fs");
const xlsx = require("xlsx");

// --- RUTAS DE LOS ARCHIVOS ---
const excelPath = "./productos_sin_imagenes_11-07-2025 13-28-18.xlsx";
const jsonPath = "./productos-all-12.json";
const outputJsonPath = "./productos_filtrados.json";

// --- 1. CARGAR EXCEL Y EXTRAER SKUs ---
const workbook = xlsx.readFile(excelPath);
const sheetName = workbook.SheetNames[0];
const worksheet = workbook.Sheets[sheetName];
const excelData = xlsx.utils.sheet_to_json(worksheet);

const skuList = excelData.map((row) => String(row.SKU)); // Asegura que todos sean string

// --- 2. CARGAR JSON DE PRODUCTOS ---
const rawData = fs.readFileSync(jsonPath, "utf8");
const productos = JSON.parse(rawData);

// --- 3. FILTRAR PRODUCTOS QUE ESTÉN EN EL JSON ---

const productosFiltrados = productos.filter((producto) => {
	const sku = String(producto.ART_CODIGO).trim();
	return skuList.includes(sku);
});

console.log(`🔎 Total de productos en el JSON: ${productosFiltrados.length}`);

// --- 4. GUARDAR RESULTADO COMO JSON ---
fs.writeFileSync(
	outputJsonPath,
	JSON.stringify(productosFiltrados, null, 2),
	"utf8"
);

console.log(
	"✔️ Proceso completado. Resultado guardado en productos_filtrados.json"
);
