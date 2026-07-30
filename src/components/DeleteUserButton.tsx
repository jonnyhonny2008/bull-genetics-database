"use client";

// A small danger button that removes a user, with a confirm so a stray click
// can't wipe an account. The server action is passed in from the (server) page.

export function DeleteUserButton({ id, name, action }: { id: string; name: string; action: (fd: FormData) => void }) {
  return (
    <form
      action={action}
      onSubmit={(e) => { if (!confirm(`Remove ${name}? This permanently deletes the account and can't be undone.`)) e.preventDefault(); }}
    >
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="btn-danger btn-sm w-full">Remove user</button>
    </form>
  );
}
