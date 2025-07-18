const { obtenerImagenDesdeSOAP } = require("../src/services/soap-service");
const logger = require("../src/services/logger");

async function intentarObtenerImagen(soapClient, url, ext) {
	const intento = await obtenerImagenDesdeSOAP(soapClient, url);
	if (intento && !intento.startsWith("C:") && !intento.startsWith("\\"))
		return intento;
	return null;
}

module.exports = {
	intentarObtenerImagen,
};
