require("dotenv").config();
const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");
const logger = require("./logger");

// const subidasEnCurso = new Map(); // hash -> Promise<string|null>
const subidasEnCurso = {
	imagen: new Map(), // hash -> Promise<string|null>
	pdf: new Map(), // hash -> Promise<string|null>
};

async function manejarSubidaConHash(tipo, hash, funcionSubida) {
	const mapa = subidasEnCurso[tipo];

	if (mapa.has(hash)) {
		return await mapa.get(hash);
	}

	const promesa = funcionSubida();
	mapa.set(hash, promesa);

	try {
		const resultado = await promesa;
		return resultado;
	} finally {
		mapa.delete(hash);
	}
}

async function subirImagenDesdeBase64(base64) {
	try {
		let mimeType = "image/webp";
		let data = base64;

		const hash = crypto.createHash("sha256").update(data).digest("hex");

		const resultado = await manejarSubidaConHash("imagen", hash, async () => {
			const existingImageUrl = await verifyImagen(hash);
			if (existingImageUrl) return existingImageUrl;

			if (base64.startsWith("C:")) {
				logger.error(`❌ Error: La imagen no es válida. ${base64}`);
				return null;
			}

			const matches = base64.match(/^data:(image\/\w+);base64,(.+)$/);
			if (matches) {
				mimeType = matches[1];
				data = matches[2];
			}

			const fileName = `imagen_${hash}.webp`;

			const form = new FormData();
			const buffer = Buffer.from(data, "base64");
			form.append("file", buffer, {
				filename: fileName,
				contentType: mimeType,
			});

			const response = await axios.post(
				`${process.env.WC_URL}/wp-json/wp/v2/media`,
				form,
				{
					headers: {
						...form.getHeaders(),
						Authorization:
							"Basic " +
							Buffer.from(
								`${process.env.WP_USER}:${process.env.WP_PASS}`
							).toString("base64"),
					},
				}
			);

			logger.info(`✅ Imagen subida: ${response.data.source_url}`);

			return response.data.source_url;
		});

		return resultado;
	} catch (error) {
		logger.error(
			`❌ Error al subir la imagen: 
			${error.response?.data || error.message}`
		);
		return null;
	}
}

async function verifyImagen(hash) {
	try {
		const response = await fetch(
			`${process.env.WC_URL}/wp-json/wp/v2/media?search=imagen_${hash}.webp`,
			{
				headers: {
					Authorization:
						"Basic " +
						Buffer.from(
							`${process.env.WP_USER}:${process.env.WP_PASS}`
						).toString("base64"),
				},
			}
		);

		const data = await response.json();

		if (data.length > 0) {
			logger.info(`✅ Imagen ya existe: ${data[0].source_url}`);
			return data[0].source_url;
		} else {
			logger.info("❌ Imagen no encontrada.");
			return null;
		}
	} catch (error) {
		console.error(`❌ Error al verificar la imagen: ${error.message}`);
		return null;
	}
}

async function subirPDFaWordPress(buffer) {
	if (!buffer) return null;

	const hash = crypto.createHash("sha256").update(buffer).digest("hex");

	return await manejarSubidaConHash("pdf", hash, async () => {
		const fileName = `manual_${hash}.pdf`;

		const existingPDFUrl = await verifyManual(hash);
		if (existingPDFUrl) return existingPDFUrl;

		const MAX_SIZE = 20 * 1024 * 1024;

		const form = new FormData();
		form.append("file", buffer, {
			filename: fileName,
			contentType: "application/pdf",
		});

		try {
			const uploadResponse = await axios.post(
				`${process.env.WC_URL}/wp-json/wp/v2/media`,
				form,
				{
					headers: {
						...form.getHeaders(),
						Authorization:
							"Basic " +
							Buffer.from(
								`${process.env.WP_USER}:${process.env.WP_PASS}`
							).toString("base64"),
					},
					maxContentLength: Infinity,
					maxBodyLength: Infinity,
				}
			);

			logger.info(`✅ PDF subido: ${uploadResponse.data.source_url}`);

			return uploadResponse.data.source_url;
		} catch (err) {
			logger.error(`❌ Error al subir PDF: ${err.message || err}`);
			console.error(`❌ Error al subir PDF: ${err.message || err}`);
			return null;
		}
	});
}

async function verifyManual(hash) {
	try {
		const response = await fetch(
			`${process.env.WC_URL}/wp-json/wp/v2/media?search=manual_${hash}.pdf`,
			{
				headers: {
					Authorization:
						"Basic " +
						Buffer.from(
							`${process.env.WP_USER}:${process.env.WP_PASS}`
						).toString("base64"),
				},
			}
		);

		const data = await response.json();

		if (data.length > 0) {
			return data[0].source_url;
		} else {
			return null;
		}
	} catch (error) {
		logger.error(`❌ Error al verificar el PDF: ${error.message}`);
		return null;
	}
}

module.exports = {
	subirImagenDesdeBase64,
	subirPDFaWordPress,
};
