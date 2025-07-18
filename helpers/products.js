const logger = require("../src/services/logger");

function redondearGuaranies(valor) {
	const monto = Math.ceil(parseFloat(valor));
	const base = monto >= 100000 ? 1000 : 100;
	return Math.ceil(monto / base) * base;
}

function redondearUSD(valor) {
	const v = parseFloat(valor);
	if (v < 100) return Math.ceil(v * 10) / 10;
	if (v < 1000) return Math.ceil(v);
	const entero = Math.ceil(v);
	const resto = entero % 10;
	return resto === 0 ? entero : entero + (10 - resto);
}

function formatearUSD(valor) {
	const redondeado = redondearUSD(valor);
	const v = parseFloat(valor);
	const opcionesFormato =
		v < 10
			? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
			: v < 100
			? { minimumFractionDigits: 1, maximumFractionDigits: 1 }
			: { minimumFractionDigits: 0, maximumFractionDigits: 0 };

	const formateado = redondeado.toLocaleString("de-DE", opcionesFormato);
	logger.info(`USD ${formateado}`);
	return formateado;
}

function construirProductoWoo(
	item,
	imagenes,
	pdfs,
	categorias = [],
	cotizacionDolar = null,
	marcas,
	fichaTecnica,
	dimensional
) {
	const parsePrecio = (valor) =>
		isNaN(valor) || valor === null || valor === undefined || valor === ""
			? null
			: parseFloat(valor);

	const precioWebUSD = parsePrecio(item.PREC_WEB);
	const precioUnitarioUSD = parsePrecio(item.PREC_UNITARIO);

	const precioUsdMetadata =
		precioWebUSD !== null ? precioWebUSD : precioUnitarioUSD;
	const usdWebFormateado =
		precioUsdMetadata !== null ? formatearUSD(precioUsdMetadata) : null;

	let regular = null;
	let web = null;

	if (cotizacionDolar && cotizacionDolar > 0) {
		if (precioWebUSD !== null) {
			logger.info(
				`[PRECIO] Usando PREC_WEB (${precioWebUSD}) como precio base para ${item.ART_CODIGO}`
			);
			web = redondearGuaranies(precioWebUSD * cotizacionDolar);

			if (precioUnitarioUSD !== null && precioUnitarioUSD > precioWebUSD) {
				regular = redondearGuaranies(precioUnitarioUSD * cotizacionDolar);
				logger.info(
					`[PRECIO] PREC_UNITARIO (${precioUnitarioUSD}) mayor que PREC_WEB (${precioWebUSD}), se usa como precio regular`
				);
			}
		} else if (precioUnitarioUSD !== null) {
			logger.info(
				`[PRECIO] PREC_WEB no disponible, usando PREC_UNITARIO (${precioUnitarioUSD}) como precio base para ${item.ART_CODIGO}`
			);
			regular = redondearGuaranies(precioUnitarioUSD * cotizacionDolar);
		}
	}

	logger.info(
		JSON.stringify(
			{
				sku: item.ART_CODIGO,
				fichaTecnica,
				dimensional,
				pdfs,
				regular,
				web,
			},
			null,
			2
		)
	);

	const precios = {};
	if (web !== null && !isNaN(web)) {
		if (regular !== null && regular > web) {
			precios.regular_price = regular.toString();
			precios.sale_price = web.toString();
		} else {
			precios.regular_price = web.toString();
		}
	} else if (regular !== null && !isNaN(regular)) {
		precios.regular_price = regular.toString();
	}

	const buildTags = () => {
		const niveles = [
			item.FAMILIA_NIVEL3,
			item.FAMILIA_NIVEL4,
			item.FAMILIA_NIVEL5,
			item.FAMILIA_NIVEL6,
			item.FAMILIA_NIVEL7,
		]
			.filter((f) => f && f !== "NULL")
			.map((name) => ({ name }));

		const datosTecnicos =
			item.DATOS_TECNICOS && item.DATOS_TECNICOS !== "SIN DATOS"
				? [{ name: item.DATOS_TECNICOS.trim() }]
				: [];

		return [...niveles, ...datosTecnicos];
	};

	const buildMetaData = () => {
		const baseMeta = [
			{ key: "manual", value: pdfs },
			{ key: "fichatecnica", value: fichaTecnica },
			{ key: "dimensional", value: dimensional },
		];

		const adicionales = [
			usdWebFormateado && { key: "precio_usd_web", value: usdWebFormateado },
			item.UNIDAD_MEDIDA && { key: "unidad_medida", value: item.UNIDAD_MEDIDA },
			item.DATOS_TECNICOS !== "SIN DATOS" && {
				key: "datos_tecnicos",
				value: item.DATOS_TECNICOS,
			},
			item.SUSTITUTO &&
				item.SUSTITUTO !== "0" && {
					key: "sustituto",
					value: item.SUSTITUTO,
				},
			item.SNP && {
				key: "snp",
				value: item.SNP,
			},
		].filter(Boolean);

		return [...baseMeta, ...adicionales];
	};

	const dimensions =
		parseFloat(item.ALTO_CM) > 0 ||
		parseFloat(item.ANCHO_CM) > 0 ||
		parseFloat(item.PROFUNDIDAD_CM) > 0
			? {
					length: item.PROFUNDIDAD_CM || "0",
					width: item.ANCHO_CM || "0",
					height: item.ALTO_CM || "0",
			  }
			: undefined;

	const existencia = Number(item.TOT_EXIST);
	let manage_stock = false;
	let stock_status = "outofstock";
	let backorders = "no";
	let catalog_visibility = item.PUBLICAR === "S" ? "visible" : "hidden";

	switch (item.SNP?.toUpperCase()) {
		case "S":
			stock_status = existencia > 0 ? "instock" : "outofstock";
			backorders = "no";
			break;

		case "P":
			stock_status = existencia > 0 ? "instock" : "onbackorder";
			backorders = "notify";
			break;

		case "N":
			stock_status = existencia > 0 ? "instock" : "outofstock";
			backorders = "no";
			catalog_visibility = "visible";
			break;

		default:
			logger.warn(`[SNP] Valor no reconocido para SNP: ${item.SNP}`);
			break;
	}

	const meta_data = buildMetaData();

	logger.info(
		`Metadata para producto ${item.ART_CODIGO}: ${JSON.stringify(
			meta_data,
			null,
			2
		)}`
	);

	return {
		name: item.ART_DESCRIPCION || "Producto SOAP sin nombre",
		type: "simple",
		...precios,
		manage_stock: false,
		sku: item.ART_CODIGO || "",
		status: "publish",
		brands: marcas.filter((id) => id).map((id) => ({ id })),
		description: item.ART_DESCRIPCION || "",
		images: imagenes,
		categories: categorias,
		tags: buildTags(),
		attributes:
			item.MARCA && item.MARCA !== "SIN"
				? [{ name: "Marca", options: [item.MARCA] }]
				: [],
		dimensions,
		weight: parseFloat(item.PESO_KG) > 0 ? item.PESO_KG.toString() : undefined,
		manage_stock,
		stock_quantity: Number.isFinite(existencia) ? parseInt(item.TOT_EXIST) : 0,
		stock_status,
		backorders,
		meta_data,
		catalog_visibility,
	};
}

module.exports = {
	construirProductoWoo,
	redondearGuaranies,
};
