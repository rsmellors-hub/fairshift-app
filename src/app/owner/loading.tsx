export default function OwnerLoading() {
  return <div className="product-page owner-overview" aria-busy="true" role="status"><h1>Overview</h1><p>Loading organisation overview…</p><div className="owner-loading-strip" aria-hidden="true">{[0, 1, 2, 3].map(key => <div key={key} />)}</div><div className="owner-loading-chart" aria-hidden="true" /></div>;
}
