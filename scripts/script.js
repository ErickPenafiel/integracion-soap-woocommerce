require("dotenv").config();
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;

const wcApi = new WooCommerceRestApi({
	url: process.env.WC_URL,
	consumerKey: process.env.WC_CONSUMER_KEY,
	consumerSecret: process.env.WC_CONSUMER_SECRET,
	version: "wc/v3",
	axiosConfig: {
		timeout: 300000,
	},
});

async function obtenerCategoriaPadreEHijxs(categoriaId) {
	try {
		// 1. Obtener la categoría actual para conocer su padre
		const { data: categoriaActual } = await wcApi.get(
			`products/categories/${categoriaId}`
		);

		if (!categoriaActual) {
			throw new Error(`Categoría con ID ${categoriaId} no encontrada.`);
		}

		// 2. Si tiene padre, obtener categoría padre
		let categoriaPadre = null;
		if (categoriaActual.parent && categoriaActual.parent !== 0) {
			const { data: padre } = await wcApi.get(
				`products/categories/${categoriaActual.parent}`
			);
			categoriaPadre = padre;
		}

		// 3. Obtener las categorías hijas de la categoría actual
		// filtrando por parent = categoriaId
		const { data: hijas } = await wcApi.get("products/categories", {
			parent: categoriaId,
			per_page: 100, // para obtener muchas si existen
		});

		return {
			categoriaActual,
			categoriaPadre,
			categoriasHijas: hijas,
		};
	} catch (error) {
		console.error("Error obteniendo categorías:", error.message);
		throw error;
	}
}

// Ejemplo de uso:
const categoriaId = 7494; // cambia por el ID que quieras

obtenerCategoriaPadreEHijxs(categoriaId)
	.then(({ categoriaActual, categoriaPadre, categoriasHijas }) => {
		console.log("Categoría actual:", categoriaActual);
		console.log("Categoría padre:", categoriaPadre);
		console.log("Categorías hijas:", categoriasHijas);
	})
	.catch(console.error);
