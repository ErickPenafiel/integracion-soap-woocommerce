const { procesarProductos } = require("./procesar-productos");
const { procesarSoloMedia } = require("./procesar-solo-media");

require("dotenv").config();

(async () => {
	let exitCode = 0;

	try {
		console.log("▶️ Iniciando sincronización principal...");
		await procesarProductos();
		console.log("✅ Sincronización principal finalizada.");
	} catch (err) {
		console.error("❌ Error en sincronización principal:", err);
		exitCode = 1;
	}

	try {
		console.log("▶️ Iniciando actualización de medios (imágenes + PDFs)...");
		await procesarSoloMedia();
		console.log("✅ Actualización de medios finalizada.");
	} catch (err) {
		console.error("❌ Error en actualización de medios:", err);
		exitCode = 1;
	}

	console.log(
		exitCode === 0
			? "✅ Proceso de sincronización finalizado."
			: "⚠️ Proceso finalizado con errores."
	);
	process.exit(exitCode);
})();
