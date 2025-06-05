const logger = require("../src/services/logger");

function redondearGuaranies(valor) {
	const monto = Math.ceil(parseFloat(valor));
	if (monto >= 100000) {
		return Math.ceil(monto / 1000) * 1000;
	} else {
		return Math.ceil(monto / 100) * 100;
	}
}

function redondearUSD(valor) {
	const v = parseFloat(valor);
	if (v < 10) {
		return Math.ceil(v * 10) / 10;
	} else if (v < 100) {
		return Math.ceil(v * 10) / 10;
	} else if (v < 1000) {
		return Math.ceil(v);
	} else {
		const entero = Math.ceil(v);
		const resto = entero % 10;
		return resto === 0 ? entero : entero + (10 - resto);
	}
}

function formatearUSD(valor) {
	const redondeado = redondearUSD(valor);
	let opcionesFormato;

	if (valor < 10) {
		opcionesFormato = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
	} else if (valor < 100) {
		opcionesFormato = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
	} else {
		opcionesFormato = { minimumFractionDigits: 0, maximumFractionDigits: 0 };
	}

	logger.info(`USD ${redondeado.toLocaleString("de-DE", opcionesFormato)}`);
	return `${redondeado.toLocaleString("de-DE", opcionesFormato)}`;
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
	logger.info(
		JSON.stringify(
			{
				sku: item.ART_CODIGO,
				fichaTecnica,
				dimensional,
				pdfs,
			},
			null,
			2
		)
	);
	let regularUSD = parseFloat(item.PREC_UNITARIO);
	let webUSD = parseFloat(item.PREC_WEB);

	let regular = regularUSD;
	let web = webUSD;

	// Redondeo de precios en Gs si hay cotización
	if (
		cotizacionDolar &&
		cotizacionDolar > 0 &&
		!isNaN(regular) &&
		!isNaN(web)
	) {
		regular *= cotizacionDolar;
		web *= cotizacionDolar;
		regular = redondearGuaranies(regular);
		web = redondearGuaranies(web);
	}

	// Formateo del precio web en USD original
	let usdWebFormateado = !isNaN(webUSD) ? formatearUSD(webUSD) : null;

	let precios =
		regular > web
			? {
					regular_price: regular.toString(),
					sale_price: web.toString(),
			  }
			: {
					regular_price: web.toString(),
			  };

	const meta_data = [
		{ key: "manual", value: pdfs },
		{ key: "fichatecnica", value: fichaTecnica },
		{ key: "dimensional", value: dimensional },
		...(usdWebFormateado
			? [{ key: "precio_usd_web", value: usdWebFormateado }]
			: []),
		...(item.UNIDAD_MEDIDA
			? [{ key: "unidad_medida", value: item.UNIDAD_MEDIDA }]
			: []),
		...(item.DATOS_TECNICOS && item.DATOS_TECNICOS !== "SIN DATOS"
			? [{ key: "datos_tecnicos", value: item.DATOS_TECNICOS }]
			: []),
		...(item.SUSTITUTO && item.SUSTITUTO !== "0"
			? [{ key: "sustituto", value: item.SUSTITUTO }]
			: []),
	];

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
		sku: item.ART_CODIGO || "",
		brands: marcas,
		description: item.ART_DESCRIPCION || "",
		images: imagenes,
		categories: categorias,
		tags: [
			...[
				item.FAMILIA_NIVEL3,
				item.FAMILIA_NIVEL4,
				item.FAMILIA_NIVEL5,
				item.FAMILIA_NIVEL6,
				item.FAMILIA_NIVEL7,
			]
				.filter((f) => f && f !== "NULL")
				.map((name) => ({ name })),
			...(item.DATOS_TECNICOS && item.DATOS_TECNICOS !== "SIN DATOS"
				? [{ name: item.DATOS_TECNICOS.trim() }]
				: []),
		],
		attributes:
			item.MARCA && item.MARCA !== "SIN"
				? [{ name: "Marca", options: [item.MARCA] }]
				: [],
		dimensions:
			parseFloat(item.ALTO_CM) > 0 ||
			parseFloat(item.ANCHO_CM) > 0 ||
			parseFloat(item.PROFUNDIDAD_CM) > 0
				? {
						length: item.PROFUNDIDAD_CM || "0",
						width: item.ANCHO_CM || "0",
						height: item.ALTO_CM || "0",
				  }
				: undefined,
		weight: parseFloat(item.PESO_KG) > 0 ? item.PESO_KG.toString() : undefined,
		manage_stock: false,
		stock_status: Number(item.TOT_EXIST) > 0 ? "instock" : "outofstock",
		stock_quantity: Number.isFinite(Number(item.TOT_EXIST))
			? parseInt(item.TOT_EXIST)
			: 0,
		meta_data,
		status: Number(item.TOT_EXIST) > 0 ? "publish" : "draft",
	};
}

module.exports = {
	construirProductoWoo,
};
