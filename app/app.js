const data = [
  { label: "Weighted avg", value: 91.2, color: "#53c7b7" },
  { label: "Current sell", value: 104.7, color: "#d8a542" },
  { label: "Current buy", value: 87.4, color: "#7f9cf5" }
];

function renderChart() {
  const container = document.querySelector("#market-chart");
  if (!container || !window.d3) return;

  container.replaceChildren();
  const width = Math.max(container.clientWidth, 320);
  const height = Math.max(container.clientHeight, 320);
  const margin = { top: 24, right: 24, bottom: 52, left: 54 };

  const svg = d3.select(container)
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("role", "img")
    .attr("aria-label", "Placeholder market price comparison chart");

  const x = d3.scaleBand()
    .domain(data.map((d) => d.label))
    .range([margin.left, width - margin.right])
    .padding(0.28);

  const y = d3.scaleLinear()
    .domain([0, d3.max(data, (d) => d.value) * 1.2])
    .nice()
    .range([height - margin.bottom, margin.top]);

  svg.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x))
    .call((g) => g.select(".domain").attr("stroke", "#303a45"))
    .call((g) => g.selectAll("line").remove())
    .call((g) => g.selectAll("text").attr("fill", "#9aa7b4"));

  svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).ticks(5))
    .call((g) => g.select(".domain").attr("stroke", "#303a45"))
    .call((g) => g.selectAll("line").attr("stroke", "#303a45"))
    .call((g) => g.selectAll("text").attr("fill", "#9aa7b4"));

  svg.selectAll("rect")
    .data(data)
    .join("rect")
    .attr("x", (d) => x(d.label))
    .attr("y", (d) => y(d.value))
    .attr("width", x.bandwidth())
    .attr("height", (d) => y(0) - y(d.value))
    .attr("rx", 4)
    .attr("fill", (d) => d.color);
}

renderChart();
window.addEventListener("resize", renderChart);
