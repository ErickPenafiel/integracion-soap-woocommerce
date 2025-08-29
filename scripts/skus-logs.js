const fs = require("fs");

const FECHA_OBJETIVO = "2025-07-18";
const FRASE_OBJETIVO = "Intento #1 para obtener imagen";

const contenidoLog = fs.readFileSync("../logs/combined.log", "utf8");
const lineas = contenidoLog.split("\n");

const skus = new Set();

for (const linea of lineas) {
	if (linea.includes(FECHA_OBJETIVO) && linea.includes(FRASE_OBJETIVO)) {
		const match = linea.match(/SKU\s(\d+)/);
		if (match) {
			skus.add(match[1]);
		}
	}
}

function generarObjetoSoloImagenesPDF(sku) {
	return {
		attributes: {
			"diffgr:id": `Table${Math.floor(Math.random() * 10000)}`,
			"msdata:rowOrder": "0",
		},
		ART_CODIGO: sku,
		URL_IMAGEN_PRIMARIA: `\\${sku}\\IMAGEN1.WEBP`,
		URL_IMAGEN_SECUNDARIA: `\\${sku}\\IMAGEN2.WEBP`,
		URL_DOCUMENTOS: `\\${sku}\\MANUAL.PDF`,
		URL_FICHA_TECNICA: `\\${sku}\\FICHA_TECNICA.PDF`,
		URL_DIMENSIONAL: `\\${sku}\\DIMENSIONAL.PDF`,
		URL_IMAGEN_3: `\\${sku}\\IMAGEN3.WEBP`,
		URL_IMAGEN_4: `\\${sku}\\IMAGEN4.WEBP`,
		URL_IMAGEN_5: `\\${sku}\\IMAGEN5.WEBP`,
		URL_IMAGEN_6: `\\${sku}\\IMAGEN6.WEBP`,
		URL_IMAGEN_7: `\\${sku}\\IMAGEN7.WEBP`,
		PUBLICAR: "S",
	};
}

const productos = Array.from(skus).map(generarObjetoSoloImagenesPDF);

fs.writeFileSync(
	"productos-generados-imagenes-pdf.json",
	JSON.stringify(productos, null, 2),
	"utf-8"
);

console.log(
	`✅ Generado productos-generados-imagenes-pdf.json con ${productos.length} productos`
);
