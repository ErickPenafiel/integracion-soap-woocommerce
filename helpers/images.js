const { obtenerImagenDesdeSOAP } = require("../src/services/soap-service");

async function intentarObtenerImagen(soapClient, url, ext) {
	const formatos = ["WEBP", "JPG", "PNG"];
	for (const formato of formatos) {
		const intento = await obtenerImagenDesdeSOAP(
			soapClient,
			url.replace(ext, formato)
		);
		if (intento && !intento.startsWith("C:")) return intento;
	}
	return null;
}

module.exports = {
	intentarObtenerImagen,
};
