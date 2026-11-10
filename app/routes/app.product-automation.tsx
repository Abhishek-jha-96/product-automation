import { useFetcher } from "react-router";

export default function ProductAutomation() {
  const fetcher = useFetcher();

  const isRunning = fetcher.state !== "idle";

  return (
    <div>
      <fetcher.Form method="POST">
        <button
          type="submit"
          name="intent"
          value="create"
          disabled={isRunning}
        >
          Create Products
        </button>

        <button
          type="submit"
          name="intent"
          value="update"
          disabled={isRunning}
        >
          Update Products
        </button>
      </fetcher.Form>

      {isRunning && <p>Automation running...</p>}

      {fetcher.data && (
        <pre>{JSON.stringify(fetcher.data, null, 2)}</pre>
      )}
    </div>
  );
}