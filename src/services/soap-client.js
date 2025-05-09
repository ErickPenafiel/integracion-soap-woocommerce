const soap = require("soap");

let cachedClient = null;

async function getSoapClient() {
	if (cachedClient) return cachedClient;

	try {
		cachedClient = await soap.createClientAsync(process.env.SOAP_URL);
		return cachedClient;
	} catch (error) {
		console.error("❌ Error creando el cliente SOAP:", error.message);
		throw error;
	}
}

module.exports = { getSoapClient };
