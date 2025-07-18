require("dotenv").config();
const express = require("express");
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;

const app = express();
const port = 5000;

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
});

// Delay helper function
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function deleteAllProducts(batchDelay = 2000) {
	let page = 1;
	let deleted = 0;

	while (true) {
		console.log(`🔄 Obteniendo productos (página ${page})...`);

		const { data: products } = await wcApi.get("products", {
			per_page: 100,
			page,
		});

		if (products.length === 0) {
			console.log("✅ No hay más productos para eliminar.");
			break;
		}

		console.log(
			`🧹 Eliminando ${products.length} productos del batch ${page}...`
		);

		for (const product of products) {
			try {
				await wcApi.delete(`products/${product.id}`, {
					force: true,
				});
				console.log(`🗑️ Producto ${product.id} eliminado.`);
				deleted++;
			} catch (error) {
				console.error(`❌ Error eliminando producto ${product.id}:`, error);
			}
		}

		console.log(`⏸️ Esperando ${batchDelay}ms antes del siguiente batch...`);
		await delay(batchDelay);

		page++;
	}

	return deleted;
}

app.get("/eliminar-productos", async (req, res) => {
	try {
		console.log("🚀 Iniciando proceso de eliminación de productos...");
		const totalEliminados = await deleteAllProducts();
		console.log(`✅ Proceso finalizado. Total eliminados: ${totalEliminados}`);
		res.json({ mensaje: `Se eliminaron ${totalEliminados} productos.` });
	} catch (err) {
		console.error("❌ Error general en la eliminación:", err);
		res.status(500).json({ error: "Error al eliminar productos" });
	}
});

app.listen(port, () => {
	console.log(`✅ Servidor escuchando en http://localhost:${port}`);
});
