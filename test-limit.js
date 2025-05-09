async function asegurarMarca(nombreMarca) {
	try {
		// Buscar la marca por nombre
		const response = await wcApi.get("products/brands", {
			search: nombreMarca,
			per_page: 100,
		});

		const marcaExistente = response.data.find(
			(brand) => brand.name.toLowerCase() === nombreMarca.toLowerCase()
		);

		if (marcaExistente) {
			return marcaExistente.id;
		}

		// Crear la marca si no existe
		const nueva = await wcApi.post("products/brands", {
			name: nombreMarca,
		});
		console.log(`🆕 Marca "${nombreMarca}" creada.`);
		return nueva.data.id;
	} catch (error) {
		console.error(`❌ Error asegurando marca "${nombreMarca}":`, error.message);
		return null;
	}
}

ase;
