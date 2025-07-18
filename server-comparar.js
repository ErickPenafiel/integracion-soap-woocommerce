const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

function normalizeSKU(value) {
	return String(value || "")
		.trim()
		.replace(/^0+/, "");
}

const soapPath = path.join(__dirname, "productos_imagenes.json");
const wooPath = path.join(__dirname, "productos_wc_info.json");

const soapData = JSON.parse(fs.readFileSync(soapPath, "utf8"));
const wooData = JSON.parse(fs.readFileSync(wooPath, "utf8"));

const wooMap = new Map(
	wooData.filter((p) => p.sku).map((p) => [normalizeSKU(p.sku), p])
);

const comparacion = soapData
	.map((producto) => {
		const sku = normalizeSKU(producto.ART_CODIGO);
		const woo = wooMap.get(sku);

		const imagenesWebService = [
			producto.isValid_IMAGEN_PRIMARIA,
			producto.isValid_IMAGEN_SECUNDARIA,
			producto.isValid_IMAGEN_3,
			producto.isValid_IMAGEN_4,
			producto.isValid_IMAGEN_5,
			producto.isValid_IMAGEN_6,
			producto.isValid_IMAGEN_7,
		].filter(Boolean).length;

		const imagenesWoo = woo?.cantidadImagenes ?? 0;

		const imagenesCoinciden = imagenesWebService === imagenesWoo;

		return {
			sku,
			imagenes_webservice: imagenesWebService,
			imagenes_woocommerce: imagenesWoo,
			imagenes_coinciden: imagenesCoinciden ? "Sí" : "No",
		};
	})
	.filter((producto) => producto.imagenes_coinciden === "No");

// Crear hoja de cálculo
const ws = XLSX.utils.json_to_sheet(comparacion);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Diferencias");

// Exportar
const outputPath = path.join(__dirname, "productos_diferentes_imagenes.xlsx");
XLSX.writeFile(wb, outputPath);

console.log("✅ Excel generado: productos_diferentes_imagenes.xlsx");
