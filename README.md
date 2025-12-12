# lazy
where I make and put apps I can't be bothered to make work cross-platform with gui by using serious technologies

## Running locally

The pages are all static, so you can test them in a browser by serving the
repository over HTTP:

```bash
cd lazy
python -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000) in your browser. The
Home tab, Timers, and Notes all use `localStorage`, so you can interact with
them right away—no build steps required. If you are reviewing a pull request,
check out the branch locally and open the same URL to try the changes before
merging.
