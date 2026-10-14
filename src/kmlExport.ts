export const placemark = (name: string, coordinates: string): string => {
	return `
      <Placemark>
        <name>${name}</name>
                <open>1</open>
                <styleUrl>#theStyle</styleUrl>
                <LineString><tessellate>1</tessellate>
                <coordinates>${coordinates}</coordinates>
                </LineString>
        </Placemark>
	`;
};

export const tail = (lat?: string | number, long?: string | number, range: number = 135000): string => {
	const lookAtBlock = (lat !== undefined && long !== undefined) ? `
	        <LookAt>
                <longitude>${long}</longitude>
                <latitude>${lat}</latitude>
                <altitude>0</altitude>
                <heading>0</heading>
                <tilt>0</tilt>
                <range>${range}</range>
                <altitudeMode>relativeToGround</altitudeMode>
        </LookAt>` : '';

	return `${lookAtBlock}
</Folder>
</kml>
	`;
};

export const head = (title: string = "Runs"): string => {
	return `
	<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2" xmlns:kml="http://www.opengis.net/kml/2.2" xmlns:atom="http://www.w3.org/2005/Atom"><Folder>
        <Style id="theStyle">
                <IconStyle><scale>1.3</scale><Icon><href>http://maps.google.com/mapfiles/kml/pushpin/ylw-pushpin.png</href></Icon><hotSpot x="20" y="2" xunits="pixels" yunits="pixels"/></IconStyle>
                <LineStyle>
                        <color>ff0000ff</color>
                        <width>3</width>
                </LineStyle>
        </Style>
        <name>${title}</name>
        <open>1</open>
        <styleUrl>#theStyle</styleUrl>
`;
};

export default {
	placemark,
	tail,
	head
};
