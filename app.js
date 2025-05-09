require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");

// Datos de acceso
const wordpressUser = process.env.WP_USER;
const appPassword = process.env.WP_PASS;
const siteUrl = process.env.WC_URL;

// Leer la imagen desde el disco
const filePath = "./img_1012600503.webp";
const fileName = "img_1012600503.webp";
const file = fs.createReadStream(filePath);

// Crear el formulario
const form = new FormData();
form.append("file", file, fileName);

// Subida usando la API
axios
	.post(`${siteUrl}/wp-json/wp/v2/media`, form, {
		headers: {
			...form.getHeaders(),
			Authorization:
				"Basic " +
				Buffer.from(`${wordpressUser}:${appPassword}`).toString("base64"),
		},
	})
	.then((response) => {
		console.log("✅ Imagen subida con éxito");
		console.log("📎 URL de la imagen:", response.data.source_url);
	})
	.catch((error) => {
		console.error(
			"❌ Error al subir la imagen:",
			error.response?.data || error.message
		);
	});
