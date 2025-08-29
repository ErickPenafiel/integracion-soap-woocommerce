require("dotenv").config();
const crypto = require("crypto");
const axios = require("axios");
const FormData = require("form-data");
const logger = require("./logger");
const retry = require("async-retry");
const sharp = require("sharp");

const subidasEnCurso = {
	imagen: new Map(),
	pdf: new Map(),
};

function detectarMimeDesdeBase64(base64) {
	const firmas = {
		"/9j/": "image/jpeg",
		iVBORw0KGgo: "image/png",
		R0lGODdh: "image/gif",
		R0lGODlh: "image/gif",
		Qk0: "image/bmp",
		AAABAAEAEBA: "image/x-icon",
		PD94bWwg: "image/svg+xml",
		T2dn: "image/webp",
		UE5H: "image/apng",
	};

	const base64Inicio = base64.slice(0, 20);

	for (const [firma, mime] of Object.entries(firmas)) {
		if (base64Inicio.startsWith(firma)) return mime;
	}

	return "application/octet-stream";
}

function extensionDesdeMime(mime) {
	if (!mime || typeof mime !== "string") return "bin";

	const [type, subtype] = mime.split("/");

	if (!subtype) return "bin";

	if (subtype === "svg+xml") return "svg";
	if (subtype === "x-icon") return "ico";

	return subtype;
}

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

async function subirImagenDesdeBase64(
	base64,
	isMarca = false,
	isCategoria = false
) {
	try {
		let mimeType = "image/webp";
		let data = base64;

		if (
			base64.startsWith("C:") ||
			base64.startsWith("http") ||
			base64.startsWith("\\\\")
		) {
			logger.error(`❌ Error: La imagen no es válida. ${base64}`);
			return null;
		}

		const matches = base64.match(/^data:(image\/[\w\+]+);base64,(.+)$/);
		if (matches) {
			mimeType = matches[1];
			data = matches[2];
		} else {
			mimeType = detectarMimeDesdeBase64(base64);

			if (mimeType === "application/octet-stream") {
				logger.warn(
					"⚠️ Tipo MIME no reconocido, se asume image/jpeg por defecto."
				);
				mimeType = "image/jpeg";
			}
		}

		let buffer = Buffer.from(data, "base64");

		if (mimeType !== "image/webp") {
			logger.info(`🔄 Convirtiendo imagen a webp desde ${mimeType}...`);
			try {
				buffer = await sharp(buffer).webp({ quality: 90 }).toBuffer();
				mimeType = "image/webp";
				logger.info("✅ Conversión a webp finalizada.");
			} catch (err) {
				logger.error(`${JSON.stringify(base64, null, 2)}}`);
				logger.error(`❌ Error al convertir a webp: ${err.message}`);
				logger.error("❌ Error al convertir a webp:", err);
				return null;
			}
		} else {
			logger.info("📎 La imagen ya está en formato webp, no se convierte.");
		}

		const hash = crypto.createHash("sha256").update(buffer).digest("hex");

		const resultado = await manejarSubidaConHash("imagen", hash, async () => {
			const existingImageUrl = await verifyImagen(hash);

			if (
				existingImageUrl &&
				existingImageUrl.startsWith("http") &&
				!existingImageUrl.includes("undefined")
			) {
				return existingImageUrl;
			}

			const extension = "webp";
			const fileName = isMarca
				? `marca_${hash}.${extension}`
				: isCategoria
				? `categoria_${hash}.${extension}`
				: `imagen_${hash}.${extension}`;

			// Subida con retry
			const response = await retry(
				async (bail) => {
					try {
						const res = await axios.post(
							`${process.env.WC_URL}/wp-json/wp/v2/media`,
							buffer,
							{
								headers: {
									Authorization:
										"Basic " +
										Buffer.from(
											`${process.env.WP_USER}:${process.env.WP_PASS}`
										).toString("base64"),
									"Content-Disposition": `attachment; filename="${fileName}"`,
									"Content-Type": mimeType,
									"Content-Length": buffer.length,
								},
								maxContentLength: Infinity,
								maxBodyLength: Infinity,
							}
						);
						return res;
					} catch (err) {
						if (err.response && err.response.status < 500) bail(err);
						throw err;
					}
				},
				{
					retries: 3,
					minTimeout: 1000,
					factor: 2,
				}
			);

			if (response?.data?.source_url?.startsWith("http")) {
				logger.info(`✅ Imagen subida: ${response.data.source_url}`);
				return response.data.source_url;
			}

			logger.error("❌ Upload fallido o sin URL válida.");
			return null;
		});

		if (!resultado || !resultado.startsWith("http")) {
			logger.warn("⚠️ Resultado inválido al subir imagen (null o mal formado)");
			return null;
		}

		return resultado;
	} catch (error) {
		logger.error(
			`❌ Error al subir la imagen: ${
				JSON.stringify(error.response?.data, null, 2) ||
				JSON.stringify(error.message, null, 2)
			}`
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

async function subirPDFaWordPress(buffer, sku = "") {
	if (!buffer) return null;

	const hash = crypto.createHash("sha256").update(buffer).digest("hex");

	return await manejarSubidaConHash("pdf", hash, async () => {
		const fileName = `manual_${hash}.pdf`;

		const existingPDFUrl = await verifyManual(hash);
		if (existingPDFUrl) return existingPDFUrl;

		try {
			const uploadResponse = await axios.post(
				`${process.env.WC_URL}/wp-json/wp/v2/media`,
				buffer,
				{
					headers: {
						Authorization:
							"Basic " +
							Buffer.from(
								`${process.env.WP_USER}:${process.env.WP_PASS}`
							).toString("base64"),
						"Content-Disposition": `attachment; filename="${fileName}"`,
						"Content-Type": "application/pdf",
						"Content-Length": buffer.length,
					},
					maxContentLength: Infinity,
					maxBodyLength: Infinity,
				}
			);

			logger.info(`✅ PDF subido: ${uploadResponse.data.source_url}`);
			return uploadResponse.data.source_url;
		} catch (err) {
			const errorMsg =
				JSON.stringify(err.response?.data?.message, null, 2) ||
				err.message ||
				err;

			logger.error(`❌ Error al subir PDF ${sku}: ${errorMsg}`);
			console.error(`❌ Error al subir PDF ${sku}: ${errorMsg}`);
			return null;
		}
	});
}

async function verifyManual(hash) {
	try {
		const data = await retry(
			async (bail) => {
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

				if (!response.ok) {
					if (response.status >= 400 && response.status < 500) {
						bail(new Error(`Error ${response.status}: ${response.statusText}`));
					}
					throw new Error(`HTTP error ${response.status}`);
				}

				return await response.json();
			},
			{
				retries: 3,
				minTimeout: 500,
				maxTimeout: 2000,
				factor: 2,
			}
		);

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
