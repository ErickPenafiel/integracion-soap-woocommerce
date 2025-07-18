require("dotenv").config();
const { procesarProductos } = require("./procesar-productos");

(async () => {
	try {
		await procesarProductos();
		console.log("✅ Proceso de sincronización finalizado.");
		process.exit(0);
	} catch (err) {
		console.error("❌ Error al ejecutar el worker:", err);
		process.exit(1);
	}
})();
