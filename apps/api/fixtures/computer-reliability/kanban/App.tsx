import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Column = "todo" | "doing" | "done";
type Task = { id: number; title: string; column: Column };

const COLUMNS: { id: Column; title: string }[] = [
  { id: "todo", title: "To do" },
  { id: "doing", title: "Doing" },
  { id: "done", title: "Done" },
];
const NEXT: Record<Column, Column | null> = { todo: "doing", doing: "done", done: null };

const STARTING_TASKS: Task[] = [
  { id: 1, title: "Write the launch post", column: "todo" },
  { id: 2, title: "Review pricing copy", column: "doing" },
  { id: 3, title: "Set up analytics", column: "done" },
];

export default function App() {
  const [tasks, setTasks] = useState<Task[]>(STARTING_TASKS);
  const [draft, setDraft] = useState("");
  const [nextId, setNextId] = useState(4);

  function addTask(event: FormEvent) {
    event.preventDefault();
    const title = draft.trim();
    if (!title) return;
    setTasks((current) => [...current, { id: nextId, title, column: "todo" }]);
    setNextId((id) => id + 1);
    setDraft("");
  }

  function moveTask(id: number) {
    setTasks((current) =>
      current.map((task) => {
        const next = NEXT[task.column];
        return task.id === id && next ? { ...task, column: next } : task;
      }),
    );
  }

  function deleteTask(id: number) {
    setTasks((current) => current.filter((task) => task.id !== id));
  }

  return (
    <main className="min-h-screen bg-canvas px-6 py-8">
      <header className="mx-auto max-w-5xl">
        <h1 className="text-3xl font-semibold text-ink">Launch board</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Add a task, move it along, and delete it when it is no longer needed.
        </p>
        <form onSubmit={addTask} className="mt-6 flex max-w-xl items-end gap-3">
          <div className="flex-1">
            <Label htmlFor="new-task">New task</Label>
            <Input
              id="new-task"
              className="mt-1"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="What needs doing?"
              autoComplete="off"
            />
          </div>
          <Button type="submit">
            <Plus />
            Add task
          </Button>
        </form>
      </header>
      <section className="mx-auto mt-8 grid max-w-5xl grid-cols-3 gap-4" aria-label="Board">
        {COLUMNS.map((column) => {
          const inColumn = tasks.filter((task) => task.column === column.id);
          return (
            <Card key={column.id} aria-label={`${column.title} column`}>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle>{column.title}</CardTitle>
                <Badge variant="neutral" aria-label={`${column.title} count`}>
                  {inColumn.length}
                </Badge>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2">
                  {inColumn.map((task) => (
                    <li
                      key={task.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink"
                    >
                      <span>{task.title}</span>
                      <span className="flex gap-1">
                        {NEXT[task.column] && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => moveTask(task.id)}
                            aria-label={`Move ${task.title}`}
                          >
                            <ArrowRight />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteTask(task.id)}
                          aria-label={`Delete ${task.title}`}
                        >
                          <Trash2 />
                        </Button>
                      </span>
                    </li>
                  ))}
                  {inColumn.length === 0 && (
                    <li className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-ink-muted">
                      Nothing here
                    </li>
                  )}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </section>
    </main>
  );
}
