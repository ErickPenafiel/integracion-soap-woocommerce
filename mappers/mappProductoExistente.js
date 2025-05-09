function mapearProductoWooExistente(producto) {
	return {
		name: producto.name,
		type: producto.type,
		regular_price: producto.regular_price,
		sku: producto.sku,
		description: producto.description,
		images: producto.images,
		categories: producto.categories,
		tags: producto.tags,
		attributes: producto.attributes,
		dimensions: producto.dimensions,
		weight: producto.weight,
		manage_stock: producto.manage_stock,
		stock_quantity: producto.stock_quantity,
		meta_data: producto.meta_data?.filter((md) =>
			["manual", "unidad_medida", "datos_tecnicos", "sustituto"].includes(
				md.key
			)
		),
	};
}

module.exports = {
	mapearProductoWooExistente,
};
