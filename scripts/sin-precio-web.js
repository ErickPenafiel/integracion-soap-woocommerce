const fs = require("fs");

const archivoEntrada = "productos-all-10.json";
const archivoSalida = "productos_sin_prec_web.json";

function precioWebInvalido(valor) {
	return (
		valor === null ||
		valor === undefined ||
		valor === "" ||
		isNaN(parseFloat(valor))
	);
}

function filtrarProductosSinPrecioWeb() {
	try {
		const data = fs.readFileSync(archivoEntrada, "utf-8");
		const productos = JSON.parse(data);
		console.log(productos.length);

		if (!Array.isArray(productos)) {
			throw new Error("El JSON de entrada no es un array de productos.");
		}

		const sinPrecioWeb = productos.filter((item) =>
			precioWebInvalido(item.PREC_WEB)
		);

		fs.writeFileSync(
			archivoSalida,
			JSON.stringify(sinPrecioWeb, null, 2),
			"utf-8"
		);

		console.log(
			`✅ Se encontraron ${sinPrecioWeb.length} productos sin PREC_WEB. Guardado en '${archivoSalida}'.`
		);
	} catch (error) {
		console.error("❌ Error al procesar el archivo:", error.message);
	}
}

filtrarProductosSinPrecioWeb();
