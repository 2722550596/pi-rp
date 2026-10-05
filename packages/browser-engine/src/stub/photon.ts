/**
 * Browser image conversion does not have the Node-only Photon runtime. The shared image
 * conversion path already treats an unavailable Photon backend as an unsupported conversion;
 * image resizing and clipboard import are absent capabilities in this Browser profile.
 */
export async function loadPhoton(): Promise<null> {
	return null;
}
