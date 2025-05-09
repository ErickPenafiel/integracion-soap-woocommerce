require("dotenv").config();
const express = require("express");
const cron = require("node-cron");
const { syncProductos } = require("./src/jobs/syncProducts");

const app = express();
const port = process.env.PORT || 5000;

// Endpoint para ejecutar la sincronización manualmente
app.get("/integrar", async (req, res) => {
	try {
		await syncProductos();
		res.send("✅ Sincronización iniciada correctamente.");
	} catch (error) {
		console.error(
			"❌ Error al ejecutar sincronización:",
			error.message || error
		);
		res.status(500).send("Error al iniciar la sincronización.");
	}
});

// Cron job: ejecuta cada 12 horas
cron.schedule("0 */12 * * *", async () => {
	console.log("🕒 Ejecutando sincronización programada...");
	await syncProductos();
});

app.listen(port, () => {
	console.log(`🚀 Servidor Express iniciado en http://localhost:${port}`);
});
