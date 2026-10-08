package hostbackup

import (
	"errors"
	"io/fs"
	"os"
)

// Sync payloads and every containing directory before publishing a manifest or
// moving live trees. Syncing only the root cannot persist nested directory entries.
func syncTree(root *os.Root) error {
	var directories []string
	err := fs.WalkDir(root.FS(), ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			directories = append(directories, path)
			return nil
		}
		// A link has no bytes of its own; syncing its directory persists it.
		// It is never followed here: inventory confines it before publication.
		if entry.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		if !entry.Type().IsRegular() {
			return &Error{Code: UnsafePath, Path: path}
		}
		f, err := openRegular(root, path)
		if err != nil {
			return err
		}
		return errors.Join(f.Sync(), f.Close())
	})
	if err != nil {
		return err
	}
	for i := len(directories) - 1; i >= 0; i-- {
		dir, err := root.OpenRoot(directories[i])
		if err != nil {
			return err
		}
		err = syncRoot(dir)
		err = errors.Join(err, dir.Close())
		if err != nil {
			return err
		}
	}
	return nil
}
