// Both arrangements share the same records and directed relationships.
export const signalGraphLayouts = {
  flow: {
    label: 'Flowchart',
    description: 'Records arranged in columns with right-angle connectors. Follow the arrowheads to trace each relationship.',
    headings: [[32, '01 / DELIVERY'], [310, '02 / ARCHITECTURE'], [588, '03 / KNOWLEDGE'], [866, '04 / SOURCE']],
    positions: {
      'reader-work': [32, 90], unify: [32, 210], position: [32, 330],
      offline: [32, 450], 'boundary-work': [32, 570], boundary: [310, 570],
      repo: [310, 210], tracker: [310, 380],
      lifecycle: [588, 90], reader: [588, 290], provenance: [588, 510],
      'project-src': [866, 90], 'reader-src': [866, 290], 'operations-src': [866, 510],
    },
  },
  network: {
    label: 'Angular network',
    description: 'Architecture at the centre, with work and evidence around it. Diagonal segments and sharp bends show connections across groups.',
    positions: {
      repo: [493, 325], lifecycle: [310, 86], reader: [753, 129],
      provenance: [770, 420], tracker: [480, 545], unify: [235, 254],
      position: [27, 388], boundary: [277, 566], offline: [27, 89],
      'reader-work': [32, 228], 'boundary-work': [53, 600],
      'project-src': [600, 36], 'reader-src': [968, 258], 'operations-src': [944, 611],
    },
  },
};

export function signalConnector(layout, source, target, index) {
  const rightward = target.x >= source.x;
  const direction = rightward ? 1 : -1;
  const offset = ((index % 5) - 2) * 6;
  const startY = source.y + 36 + offset;
  const endY = target.y + 36 + offset;

  if (layout === 'flow') {
    if (source.x === target.x) {
      const x = source.x + 184;
      const elbow = x + 26 + offset;
      return `M${x} ${startY} H${elbow} V${endY} H${x + 3}`;
    }
    const startX = source.x + (rightward ? 184 : 0);
    const endX = target.x + (rightward ? -3 : 187);
    const elbow = endX - direction * (43 + offset);
    return `M${startX} ${startY} H${elbow} V${endY} H${endX}`;
  }

  // Use vertical ports when boxes overlap on the horizontal axis.
  if (Math.abs(target.x - source.x) < 210) {
    const down = target.y > source.y;
    const startX = source.x + 92 + offset;
    const endX = target.x + 92 + offset;
    const fromY = source.y + (down ? 72 : 0);
    const toY = target.y + (down ? -3 : 75);
    const step = (toY - fromY) / 3;
    return `M${startX} ${fromY} V${fromY + step} L${endX} ${toY - step} V${toY}`;
  }
  const startX = source.x + (rightward ? 184 : 0);
  const endX = target.x + (rightward ? -3 : 187);
  const step = (endX - startX) / 3;
  return `M${startX} ${startY} H${startX + step} L${endX - step} ${endY} H${endX}`;
}
