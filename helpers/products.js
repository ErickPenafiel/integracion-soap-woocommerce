function redondearGuaranies(valor) {
	const monto = Math.ceil(parseFloat(valor));
	if (monto >= 100000) {
		return Math.ceil(monto / 1000) * 1000;
	} else {
		return Math.ceil(monto / 100) * 100;
	}
}

function redondearUSD(valor) {
	if (valor < 100) {
		return Math.ceil(valor * 10) / 10;
	} else if (valor < 1000) {
		return Math.ceil(valor);
	} else {
		const redondeado = Math.ceil(valor);
		const unidades = redondeado % 10;
		return redondeado + (10 - unidades);
	}
}
function formatearUSD(valor) {
	const redondeado = redondearUSD(valor);

	let opcionesFormato;

	if (redondeado < 100) {
		opcionesFormato = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
	} else {
		opcionesFormato = { minimumFractionDigits: 0, maximumFractionDigits: 0 };
	}

	return `USD ${redondeado.toLocaleString("en-US", opcionesFormato)}`;
}

function construirProductoWoo(
	item,
	imagenes,
	pdfs,
	categorias = [],
	cotizacionDolar = null,
	marcas
) {
	let regularUSD = parseFloat(item.PREC_UNITARIO || 0);
	let webUSD = parseFloat(item.PREC_WEB || 0);

	let regular = regularUSD;
	let web = webUSD;

	let usdWebFormateado = null;

	if (cotizacionDolar && cotizacionDolar > 0) {
		regular *= cotizacionDolar;
		web *= cotizacionDolar;

		regular = redondearGuaranies(regular);
		web = redondearGuaranies(web);
	}

	if (!isNaN(webUSD)) {
		usdWebFormateado = formatearUSD(webUSD);
	}

	let precios =
		regular > web
			? {
					regular_price: regular.toString(),
					sale_price: web.toString(),
			  }
			: {
					regular_price: web.toString(),
			  };

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
		meta_data: [
			{ key: "manual", value: pdfs },
			{ key: "precio_usd_web", value: usdWebFormateado },
			...(item.UNIDAD_MEDIDA
				? [{ key: "unidad_medida", value: item.UNIDAD_MEDIDA }]
				: []),
			...(item.DATOS_TECNICOS && item.DATOS_TECNICOS !== "SIN DATOS"
				? [{ key: "datos_tecnicos", value: item.DATOS_TECNICOS }]
				: []),
			...(item.SUSTITUTO && item.SUSTITUTO !== "0"
				? [{ key: "sustituto", value: item.SUSTITUTO }]
				: []),
		],
	};
}

module.exports = {
	construirProductoWoo,
};
